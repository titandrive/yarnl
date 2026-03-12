// API base URL
const API_URL = '';

// Auth state
let currentUser = null;
let authMode = 'single-user';
let appInitialized = false;

// All localStorage keys that should sync across devices
const SYNCED_SETTING_KEYS = [
    // Theme
    'theme', 'themeBase', 'themeMode',
    'autoModeEnabled', 'autoType', 'dayStartTime', 'nightStartTime',
    'useGradient', 'tagline', 'showTagline', 'showLogo',
    'showHeaderThemeToggle', 'fontFamily', 'customFontName',
    // Mascot
    'selectedMascot', 'themeMascotEnabled', 'mascotAction',
    // Library display
    'showTabCounts', 'showTypeBadge', 'showStatusBadge',
    'showCategoryBadge', 'showStarBadge', 'showRatingBadge',
    'librarySort', 'libraryShowCompleted', 'libraryShowCurrent',
    'libraryShowPdf', 'libraryShowMarkdown', 'libraryHighlightMode',
    'libraryPinCurrent', 'libraryPinFavorites', 'libraryShowFilter',
    'libraryCategoryFilter',
    // Navigation & PDF
    'defaultPage', 'defaultPdfZoom', 'pdfScrollMode', 'arrowKeysScroll',
    'scrollPageButtons', 'counterLayout', 'pinnedCounters',
    // Projects
    'projectSort', 'projectShowFilter',
    // Behavior
    'showWhatsNew', 'autoCurrentOnTimer', 'autoTimerDefault', 'inactivityTimeout', 'defaultCategory',
    'enableDirectDelete', 'hapticFeedback', 'wakeLock', 'keyboardShortcuts', 'showInventoryTab',
    // Notes
    'notesLivePreview', 'notesPopoverSize',
    // Media
    'mediaRemoteEnabled',
    // Backup
    'backupScheduleEnabled', 'backupSchedule',
    'backupPruneEnabled', 'backupPruneMode',
    'backupPruneValue', 'backupTime',
    // Inventory
    'patternColumnOrder', 'yarnColumnOrder', 'hookColumnOrder',
    'patternHiddenColumns', 'yarnHiddenColumns', 'hookHiddenColumns',
    'yarnSort', 'hookSort'
];

// Debounced settings sync to server
const _originalSetItem = localStorage.setItem.bind(localStorage);
const _originalRemoveItem = localStorage.removeItem.bind(localStorage);
let _settingsSyncTimer = null;

function scheduleSyncSettings() {
    if (_settingsSyncTimer) clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = setTimeout(syncSettingsToServer, 2000);
}

async function syncSettingsToServer() {
    _settingsSyncTimer = null;
    try {
        const settings = getClientSettings();
        await fetch(`${API_URL}/api/user/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
    } catch (error) {
        console.error('Settings sync failed:', error);
    }
}

// Flush pending settings sync before page unload
window.addEventListener('beforeunload', () => {
    if (_settingsSyncTimer) {
        clearTimeout(_settingsSyncTimer);
        const settings = getClientSettings();
        navigator.sendBeacon(
            `${API_URL}/api/user/settings`,
            new Blob([JSON.stringify(settings)], { type: 'application/json' })
        );
    }
});

// Monkey-patch localStorage to auto-sync setting changes
localStorage.setItem = function(key, value) {
    _originalSetItem(key, value);
    if (currentUser && SYNCED_SETTING_KEYS.includes(key)) {
        scheduleSyncSettings();
    }
};

localStorage.removeItem = function(key) {
    _originalRemoveItem(key);
    if (currentUser && SYNCED_SETTING_KEYS.includes(key)) {
        scheduleSyncSettings();
    }
};

// Wake lock
let wakeLockSentinel = null;

async function requestWakeLock() {
    if (localStorage.getItem('wakeLock') !== 'true') return;
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
    } catch (e) {
        // Wake lock request failed (e.g. low battery)
    }
}

function releaseWakeLock() {
    if (wakeLockSentinel) {
        wakeLockSentinel.release();
        wakeLockSentinel = null;
    }
}

// Re-acquire wake lock when returning to tab (browser releases it on visibility change)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLockSentinel) {
        const isPdfOpen = document.getElementById('pdf-viewer-container')?.style.display === 'flex';
        const isMdOpen = document.getElementById('markdown-viewer-container')?.style.display === 'flex';
        if (isPdfOpen || isMdOpen) requestWakeLock();
    }
});

// Load settings from server and apply to localStorage
// Migrate legacy pinnedCounters_* keys to consolidated format
(function migratePinnedCounters() {
    if (localStorage.getItem('_pinnedMigrated')) return;
    const all = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('pinnedCounters_')) {
            const patternId = key.slice('pinnedCounters_'.length);
            try {
                const ids = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(ids) && ids.length > 0) all[patternId] = ids;
            } catch {}
        }
    }
    if (Object.keys(all).length > 0) {
        localStorage.setItem('pinnedCounters', JSON.stringify(all));
    }
    // Clean up old keys
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('pinnedCounters_')) toRemove.push(key);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
    _originalSetItem('_pinnedMigrated', '1');
})();

async function loadServerSettings() {
    try {
        const response = await fetch(`${API_URL}/api/user/settings`);
        if (!response.ok) return;
        const serverSettings = await response.json();
        if (!serverSettings || Object.keys(serverSettings).length === 0) {
            // No server settings yet — push current local settings up (migration)
            syncSettingsToServer();
            return;
        }
        // Check if server settings differ from localStorage
        let changed = false;
        for (const [key, value] of Object.entries(serverSettings)) {
            if (value !== null && value !== undefined && SYNCED_SETTING_KEYS.includes(key)) {
                if (localStorage.getItem(key) !== value) {
                    changed = true;
                }
                _originalSetItem(key, value);
            }
        }
        // If settings changed, reload so theme/UI picks up new values
        // (theme uses closure variables that can't be updated after init)
        if (changed) {
            window.location.reload();
        }
    } catch (error) {
        console.error('Failed to load server settings:', error);
    }
}

// Auth functions
async function checkAuth() {
    try {
        // Check auth mode first
        const modeResponse = await fetch(`${API_URL}/api/auth/mode`);
        const modeData = await modeResponse.json();
        authMode = modeData.mode;

        if (authMode === 'single-user') {
            // No login needed, auto-authenticated as admin
            const userResponse = await fetch(`${API_URL}/api/auth/me`);
            if (userResponse.ok) {
                currentUser = await userResponse.json();
            }
            return true;
        }

        // Multi-user mode: check if we have a valid session
        const userResponse = await fetch(`${API_URL}/api/auth/me`);
        if (userResponse.ok) {
            currentUser = await userResponse.json();
            return true;
        }

        // No valid session
        return false;
    } catch (error) {
        console.error('Auth check failed:', error);
        return false;
    }
}

function showLogin() {
    const earlyStyle = document.getElementById('early-tab-style');
    if (earlyStyle) earlyStyle.remove();
    document.getElementById('login-container').style.display = 'flex';
    document.querySelector('.container').style.display = 'none';
    // Set mascot in login - ensure proper path
    const savedMascot = localStorage.getItem('selectedMascot') || '/mascots/default.png';
    const loginMascot = document.getElementById('login-mascot');
    if (loginMascot) {
        // Ensure path starts with /
        loginMascot.src = savedMascot.startsWith('/') ? savedMascot : '/' + savedMascot;
    }
    // Check if OIDC is enabled
    checkOIDCEnabled();
    // Focus username field
    setTimeout(() => document.getElementById('login-username').focus(), 100);
}

function showApp() {
    const earlyStyle = document.getElementById('early-tab-style');
    if (earlyStyle) earlyStyle.remove();
    document.getElementById('login-container').style.display = 'none';
    document.querySelector('.container').style.display = 'block';
    updateUIForUser();
}

function updateUIForUser() {
    // Hide pattern upload options based on granular permissions
    if (currentUser) {
        const isAdmin = currentUser.role === 'admin';
        const canPdf = isAdmin || currentUser.canUploadPdf;
        const canMarkdown = isAdmin || currentUser.canCreateMarkdown;
        const uploadPdf = document.getElementById('add-upload-pdf');
        const newPattern = document.getElementById('add-new-pattern');
        if (uploadPdf) uploadPdf.style.display = canPdf ? '' : 'none';
        if (newPattern) newPattern.style.display = canMarkdown ? '' : 'none';
        localStorage.setItem('canUploadPdf', canPdf ? 'true' : 'false');
        localStorage.setItem('canCreateMarkdown', canMarkdown ? 'true' : 'false');
    }

    // Load user list for admin panel
    loadUsers();

    // Show/hide admin nav button and section based on role
    const usersNavBtn = document.getElementById('admin-nav-btn');
    const adminSection = document.getElementById('admin-section');
    const isAdmin = currentUser?.role === 'admin';

    if (usersNavBtn) {
        usersNavBtn.style.display = isAdmin ? '' : 'none';
    }
    if (adminSection) {
        adminSection.style.display = isAdmin ? '' : 'none';
    }
    if (isAdmin) {
        initOIDCSettings();
        initRavelrySettings();
        initDefaultCategories();
    }

    // Show admin backup section and divider for admins
    const adminBackupSection = document.getElementById('admin-backup-section');
    const adminBackupDivider = document.getElementById('admin-backup-divider');
    if (adminBackupSection) {
        adminBackupSection.style.display = isAdmin ? '' : 'none';
    }
    if (adminBackupDivider) {
        adminBackupDivider.style.display = isAdmin ? '' : 'none';
    }

    // Show/hide Ravelry nav button and add menu item based on whether it's enabled + connected
    fetch(`${API_URL}/api/ravelry/enabled`).then(r => r.json()).then(ravelryData => {
        const ravelryNavBtn = document.getElementById('ravelry-nav-btn');
        const ravelryAddBtn = document.getElementById('add-ravelry-url');
        if (ravelryNavBtn) ravelryNavBtn.style.display = ravelryData.enabled ? '' : 'none';
        if (ravelryData.enabled && ravelryAddBtn) {
            fetch(`${API_URL}/api/ravelry/status`).then(r => r.json()).then(statusData => {
                ravelryAddBtn.style.display = statusData.connected ? '' : 'none';
            }).catch(() => {});
        }
    }).catch(() => {});

    // Update current user info
    const userInfo = document.getElementById('current-user-info');
    if (userInfo && currentUser) {
        userInfo.textContent = `${currentUser.username} (${currentUser.role})`;
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');

    errorDiv.textContent = '';

    try {
        const response = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: password || undefined })
        });

        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            // Sync settings from server before showing UI
            await loadServerSettings();
            // Clear hash and set default tab BEFORE showing app to prevent flash
            window.location.hash = '';
            const defaultPage = localStorage.getItem('defaultPage') || 'current';
            localStorage.setItem('activeTab', defaultPage);
            showApp();
            // Only initialize UI components on first login
            if (!appInitialized) {
                initTabs();
                initUpload();
                initEditModal();
                initPDFViewer();
                initLibraryFilters();
                initSettings();
                initAddMenu();
                initNewPatternPanel();
                initThumbnailSelector();
                initTimer();
                initBackups();
                initNavigation();
                initGlobalDragDrop();
                initServerEvents();
                initHorizontalScroll();
                initUserManagement();
                appInitialized = true;
            }
            // Always refresh user-specific data and UI
            await loadAccountInfo();
            updateUIForUser();
            await Promise.all([loadPatterns(), loadProjects(), loadYarns(), loadHooks()]);
            loadCurrentPatterns();
            await loadCurrentProjects();
            updateTabCounts();
            loadCategories();
            loadHashtags();
            switchToTab(defaultPage, false);
        } else {
            const error = await response.json();
            errorDiv.textContent = error.error || 'Login failed';
        }
    } catch (error) {
        console.error('Login error:', error);
        errorDiv.textContent = 'Login failed. Please try again.';
    }
}

async function handleLogout() {
    try {
        await fetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
    } catch (error) {
        console.error('Logout error:', error);
    }
    currentUser = null;
    localStorage.removeItem('canUploadPdf');
    localStorage.removeItem('canCreateMarkdown');
    showLogin();
}

function initAuth() {
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    const oidcLoginBtn = document.getElementById('oidc-login-btn');
    if (oidcLoginBtn) {
        oidcLoginBtn.addEventListener('click', () => {
            window.location.href = `${API_URL}/api/auth/oidc/login`;
        });
    }
}

// User management functions
let allUsers = [];
let oidcInfo = { enabled: false, providerName: 'SSO' };

async function loadUsers() {
    if (!currentUser || currentUser.role !== 'admin') return;

    try {
        // Load OIDC info for SSO toggle display
        const oidcResponse = await fetch(`${API_URL}/api/auth/oidc/enabled`);
        if (oidcResponse.ok) {
            const data = await oidcResponse.json();
            oidcInfo = { enabled: data.enabled, providerName: data.providerName || 'SSO' };
        }

        const response = await fetch(`${API_URL}/api/users`);
        if (response.ok) {
            allUsers = await response.json();
            displayUsers();
        }
    } catch (error) {
        console.error('Failed to load users:', error);
    }
}

function displayUsers() {
    const container = document.getElementById('users-list');
    if (!container) return;

    // Remember which cards were expanded
    const expandedIds = [...container.querySelectorAll('.user-card.expanded')].map(c => c.dataset.userId);

    if (allUsers.length === 0) {
        container.innerHTML = '<p class="empty-state">No users found</p>';
        return;
    }

    container.innerHTML = allUsers.map(user => `
        <div class="user-card" data-user-id="${user.id}">
            <div class="user-card-header" onclick="toggleUserCard(this)">
                <div class="user-card-info">
                    <span class="user-name">${user.username}</span>
                    <span class="user-badge role-badge ${user.role}">${user.role}</span>
                    ${user.oidc_provider ? `<span class="user-badge oidc-badge">${user.oidc_provider}</span>` : '<span class="user-badge local-badge">LOCAL</span>'}
                    ${user.has_password ? '<span class="user-badge password-badge">pw</span>' : ''}
                    ${user.id === currentUser.id ? '<span class="user-current-badge">You</span>' : ''}
                </div>
                <div class="user-card-expand-hint">
                    <span class="expand-hint-text">Click to manage</span>
                    <svg class="user-card-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </div>
            </div>
            <div class="user-card-body">
                ${user.id === currentUser.id ?
                    '<p class="user-card-note">You cannot modify your own account here. Use Account settings instead.</p>' :
                    `<div class="user-account-actions">
                        <button class="btn btn-secondary btn-sm btn-with-icon" onclick="showAdminInput(this, 'username', '${user.username}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                            Change Username
                        </button>
                        <button class="btn btn-secondary btn-sm btn-with-icon" onclick="showAdminInput(this, 'password', '')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            ${user.has_password ? 'Change Password' : 'Set Password'}
                        </button>
                        ${user.has_password ? `<button class="btn btn-secondary btn-sm btn-with-icon" onclick="adminRemovePassword(${user.id}, this)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><line x1="9" y1="15" x2="15" y2="19"/><line x1="15" y1="15" x2="9" y2="19"/></svg>
                            Remove PW
                        </button>` : ''}
                        <button class="btn btn-danger btn-sm btn-with-icon" onclick="deleteUser(${user.id}, this)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            Delete
                        </button>
                        <div class="user-admin-inline-input" style="display:none;">
                            <input type="text" class="settings-input" data-user-id="${user.id}">
                            <button class="btn btn-sm" onclick="submitAdminField(${user.id}, this.parentElement.dataset.field, this)">Save</button>
                            <button class="btn btn-secondary btn-sm" onclick="hideAdminInput(this)">Cancel</button>
                        </div>
                    </div>
                    <div class="user-permissions-grid">
                        <div class="user-perm-item">
                            <div class="user-perm-info">
                                <span class="user-perm-title">User is admin</span>
                                <span class="user-perm-desc">User has access to admin panel</span>
                            </div>
                            <label class="toggle-switch toggle-sm">
                                <input type="checkbox" ${user.role === 'admin' ? 'checked' : ''} onchange="updateUserRole(${user.id}, this.checked ? 'admin' : 'user')">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="user-perm-item">
                            <div class="user-perm-info">
                                <span class="user-perm-title">Can add patterns</span>
                                <span class="user-perm-desc">PDF and Markdown uploads</span>
                            </div>
                            <div class="user-perm-toggles">
                                <label class="toggle-label-inline">
                                    <label class="toggle-switch toggle-sm">
                                        <input type="checkbox" ${user.can_upload_pdf !== false ? 'checked' : ''} onchange="toggleUserPermission(${user.id}, 'canUploadPdf', this.checked)">
                                        <span class="toggle-slider"></span>
                                    </label>
                                    <span>PDF</span>
                                </label>
                                <label class="toggle-label-inline">
                                    <label class="toggle-switch toggle-sm">
                                        <input type="checkbox" ${user.can_create_markdown !== false ? 'checked' : ''} onchange="toggleUserPermission(${user.id}, 'canCreateMarkdown', this.checked)">
                                        <span class="toggle-slider"></span>
                                    </label>
                                    <span>MD</span>
                                </label>
                            </div>
                        </div>
                        <div class="user-perm-item">
                            <div class="user-perm-info">
                                <span class="user-perm-title">Password required</span>
                                <span class="user-perm-desc">User can disable password</span>
                            </div>
                            <label class="toggle-switch toggle-sm">
                                <input type="checkbox" ${user.password_required ? 'checked' : ''} onchange="togglePasswordRequired(${user.id}, this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="user-perm-item">
                            <div class="user-perm-info">
                                <span class="user-perm-title">Can change username</span>
                                <span class="user-perm-desc">User can change their username</span>
                            </div>
                            <label class="toggle-switch toggle-sm">
                                <input type="checkbox" ${user.can_change_username !== false ? 'checked' : ''} onchange="toggleCanChangeUsername(${user.id}, this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="user-perm-item">
                            <div class="user-perm-info">
                                <span class="user-perm-title">Can change password</span>
                                <span class="user-perm-desc">User can change their password</span>
                            </div>
                            <label class="toggle-switch toggle-sm">
                                <input type="checkbox" ${user.can_change_password !== false ? 'checked' : ''} onchange="toggleCanChangePassword(${user.id}, this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="user-perm-item ${!oidcInfo.enabled ? 'disabled' : ''}">
                            <div class="user-perm-info">
                                <span class="user-perm-title">Can use ${oidcInfo.providerName}</span>
                                <span class="user-perm-desc">${oidcInfo.enabled ? `User can login with ${oidcInfo.providerName}` : 'SSO is not enabled'}</span>
                            </div>
                            <label class="toggle-switch toggle-sm">
                                <input type="checkbox" ${user.oidc_allowed !== false ? 'checked' : ''} onchange="toggleOidcAllowed(${user.id}, this.checked)" ${!oidcInfo.enabled ? 'disabled' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>`
                }
            </div>
        </div>
    `).join('');

    // Re-expand previously expanded cards
    expandedIds.forEach(id => {
        const card = container.querySelector(`.user-card[data-user-id="${id}"]`);
        if (card) card.classList.add('expanded');
    });
}

function toggleUserCard(header) {
    const card = header.closest('.user-card');
    card.classList.toggle('expanded');
}

function openAddUserModal() {
    const modal = document.getElementById('add-user-modal');
    if (modal) {
        modal.style.display = 'flex';
        // Reset form
        document.getElementById('new-user-username').value = '';
        document.getElementById('new-user-password').value = '';
        document.getElementById('new-user-admin').checked = false;
        document.getElementById('new-user-can-add').checked = true;
        document.getElementById('new-user-require-pw').checked = false;
        document.getElementById('new-user-allow-sso').checked = true;
        document.getElementById('new-user-change-username').checked = true;
        document.getElementById('new-user-change-password').checked = true;
        // Focus username field
        setTimeout(() => document.getElementById('new-user-username').focus(), 100);
        // Add escape key handler
        document.addEventListener('keydown', handleAddUserModalEscape);
    }
}

function closeAddUserModal() {
    const modal = document.getElementById('add-user-modal');
    if (modal) {
        modal.style.display = 'none';
        document.removeEventListener('keydown', handleAddUserModalEscape);
    }
}

function handleAddUserModalEscape(e) {
    if (e.key === 'Escape') {
        closeAddUserModal();
    }
}

async function toggleUserPermission(userId, permission, value) {
    try {
        const body = {};
        body[permission] = value;

        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (response.ok) {
            showToast('User updated');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update user', 'error');
            loadUsers(); // Reload to reset UI
        }
    } catch (error) {
        console.error('Failed to update user:', error);
        showToast('Failed to update user', 'error');
        loadUsers();
    }
}

async function updateUserRole(userId, role) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role })
        });

        if (response.ok) {
            showToast('User role updated');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update role', 'error');
            loadUsers();
        }
    } catch (error) {
        console.error('Failed to update role:', error);
        showToast('Failed to update role', 'error');
        loadUsers();
    }
}

async function deleteUser(userId, btn) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm Delete';
        return;
    }

    // Second click - actually delete
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showToast('User deleted');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to delete user', 'error');
            btn.classList.remove('confirm-delete');
            btn.textContent = 'Delete User';
        }
    } catch (error) {
        console.error('Failed to delete user:', error);
        showToast('Failed to delete user', 'error');
        btn.classList.remove('confirm-delete');
        btn.textContent = 'Delete User';
    }
}

function showAdminInput(btn, field, defaultValue) {
    const container = btn.closest('.user-account-actions');
    const inputDiv = container.querySelector('.user-admin-inline-input');
    const input = inputDiv.querySelector('input');

    // Hide all icon buttons
    container.querySelectorAll('.btn-icon').forEach(b => b.style.display = 'none');

    // Show and configure input
    inputDiv.style.display = 'flex';
    inputDiv.dataset.field = field;
    input.type = field === 'password' ? 'password' : 'text';
    input.placeholder = field === 'password' ? 'New password' : 'New username';
    input.value = defaultValue;
    setTimeout(() => input.focus(), 50);
}

function hideAdminInput(btn) {
    const container = btn.closest('.user-account-actions');
    const inputDiv = container.querySelector('.user-admin-inline-input');

    // Show all icon buttons
    container.querySelectorAll('.btn-icon').forEach(b => b.style.display = '');
    inputDiv.style.display = 'none';
}

async function submitAdminField(userId, fieldOrBtn, btn) {
    const container = btn.parentElement;
    const field = container.dataset.field || fieldOrBtn;
    const input = container.querySelector('input');
    const value = input.value.trim();
    if (!value) return;

    const body = field === 'username' ? { username: value } : { password: value };

    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (response.ok) {
            showToast(field === 'username' ? 'Username changed' : 'Password set');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || `Failed to change ${field}`, 'error');
        }
    } catch (error) {
        console.error(`Failed to change ${field}:`, error);
        showToast(`Failed to change ${field}`, 'error');
    }
}

// Keep for backwards compatibility but no longer used
async function submitAdminPassword(userId, btn) {
    const input = btn.parentElement.querySelector('input');
    const newPassword = input.value;
    if (!newPassword) return;

    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPassword })
        });

        if (response.ok) {
            showToast('Password set');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to set password', 'error');
        }
    } catch (error) {
        console.error('Failed to set password:', error);
        showToast('Failed to set password', 'error');
    }
}

async function adminRemovePassword(userId, btn) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm';
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ removePassword: true })
        });

        if (response.ok) {
            showToast('Password removed');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to remove password', 'error');
        }
    } catch (error) {
        console.error('Failed to remove password:', error);
        showToast('Failed to remove password', 'error');
    }
}

async function removeUserPassword(userId) {
    const adminPassword = prompt('Enter your admin password to confirm:');
    if (!adminPassword) return;

    try {
        const response = await fetch(`${API_URL}/api/users/${userId}/remove-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminPassword })
        });

        if (response.ok) {
            showToast('Password removed - user can now login without password');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to remove password', 'error');
        }
    } catch (error) {
        console.error('Failed to remove password:', error);
        showToast('Failed to remove password', 'error');
    }
}

async function togglePasswordRequired(userId, required) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passwordRequired: required })
        });

        if (response.ok) {
            showToast(required ? 'Password now required for this user' : 'Password no longer required');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update setting', 'error');
            loadUsers();
        }
    } catch (error) {
        console.error('Failed to update password requirement:', error);
        showToast('Failed to update setting', 'error');
        loadUsers();
    }
}

async function toggleOidcAllowed(userId, allowed) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oidcAllowed: allowed })
        });

        if (response.ok) {
            showToast(allowed ? 'SSO enabled for user' : 'SSO disabled for user');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update setting', 'error');
            loadUsers();
        }
    } catch (error) {
        console.error('Failed to update OIDC setting:', error);
        showToast('Failed to update setting', 'error');
        loadUsers();
    }
}

async function toggleCanChangeUsername(userId, allowed) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canChangeUsername: allowed })
        });

        if (response.ok) {
            showToast(allowed ? 'Username changes enabled' : 'Username changes disabled');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update setting', 'error');
            loadUsers();
        }
    } catch (error) {
        console.error('Failed to update setting:', error);
        showToast('Failed to update setting', 'error');
        loadUsers();
    }
}

async function toggleCanChangePassword(userId, allowed) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canChangePassword: allowed })
        });

        if (response.ok) {
            showToast(allowed ? 'Password changes enabled' : 'Password changes disabled');
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update setting', 'error');
            loadUsers();
        }
    } catch (error) {
        console.error('Failed to update setting:', error);
        showToast('Failed to update setting', 'error');
        loadUsers();
    }
}

async function addNewUser() {
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-password').value;
    const role = document.getElementById('new-user-admin').checked ? 'admin' : 'user';
    const canUploadPdf = document.getElementById('new-user-can-upload-pdf').checked;
    const canCreateMarkdown = document.getElementById('new-user-can-create-markdown').checked;
    const passwordRequired = document.getElementById('new-user-require-pw').checked;
    const oidcAllowed = document.getElementById('new-user-allow-sso').checked;
    const canChangeUsername = document.getElementById('new-user-change-username').checked;
    const canChangePassword = document.getElementById('new-user-change-password').checked;

    if (!username) {
        showToast('Username is required', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password: password || undefined,
                role,
                canUploadPdf,
                canCreateMarkdown,
                passwordRequired,
                oidcAllowed,
                canChangeUsername,
                canChangePassword
            })
        });

        if (response.ok) {
            showToast('User created');
            closeAddUserModal();
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to create user', 'error');
        }
    } catch (error) {
        console.error('Failed to create user:', error);
        showToast('Failed to create user', 'error');
    }
}

function initUserManagement() {
    const addUserBtn = document.getElementById('add-user-btn');
    if (addUserBtn) {
        addUserBtn.addEventListener('click', addNewUser);
    }

    // Logout buttons (settings and header)
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    const headerLogoutBtn = document.getElementById('header-logout-btn');
    if (headerLogoutBtn) {
        headerLogoutBtn.addEventListener('click', handleLogout);
    }

    // Update current user info
    const userInfo = document.getElementById('current-user-info');
    if (userInfo && currentUser) {
        userInfo.textContent = `${currentUser.username} (${currentUser.role})`;
    }

    // Show/hide admin nav button based on role
    const usersNavBtn = document.getElementById('admin-nav-btn');
    const isAdmin = currentUser?.role === 'admin';
    if (usersNavBtn) {
        usersNavBtn.style.display = isAdmin ? '' : 'none';
    }
    if (isAdmin) {
        loadUsers();
        initOIDCSettings();
        initRavelrySettings();
        initDefaultCategories();
    }

    // Setup password management - inline forms
    const changePasswordBtn = document.getElementById('change-password-btn');
    const changePasswordForm = document.getElementById('change-password-form');
    const changePasswordItem = document.getElementById('change-password-item');
    if (changePasswordBtn && changePasswordForm) {
        changePasswordBtn.addEventListener('click', () => {
            changePasswordBtn.style.display = 'none';
            changePasswordForm.style.display = 'flex';
            changePasswordItem.classList.add('expanded');
            const curInput = document.getElementById('current-password-input');
            if (curInput && curInput.style.display !== 'none') {
                curInput.focus();
            } else {
                document.getElementById('new-password-input').focus();
            }
        });
        document.getElementById('cancel-password-btn').addEventListener('click', () => {
            changePasswordForm.style.display = 'none';
            changePasswordBtn.style.display = '';
            changePasswordItem.classList.remove('expanded');
            changePasswordForm.querySelectorAll('input').forEach(i => i.value = '');
        });
        document.getElementById('save-password-btn').addEventListener('click', handleChangePassword);
    }

    const removePasswordBtn = document.getElementById('remove-password-btn');
    const removePasswordForm = document.getElementById('remove-password-form');
    const removePasswordItem = document.getElementById('remove-password-item');
    if (removePasswordBtn && removePasswordForm) {
        removePasswordBtn.addEventListener('click', () => {
            removePasswordBtn.style.display = 'none';
            removePasswordForm.style.display = 'flex';
            removePasswordItem.classList.add('expanded');
            document.getElementById('remove-password-input').focus();
        });
        document.getElementById('cancel-remove-password-btn').addEventListener('click', () => {
            removePasswordForm.style.display = 'none';
            removePasswordBtn.style.display = '';
            removePasswordItem.classList.remove('expanded');
            document.getElementById('remove-password-input').value = '';
        });
        document.getElementById('confirm-remove-password-btn').addEventListener('click', handleRemoveOwnPassword);
    }

    // Setup username change
    const saveUsernameBtn = document.getElementById('save-username-btn');
    if (saveUsernameBtn) {
        saveUsernameBtn.addEventListener('click', handleChangeUsername);
    }

    // Setup SSO linking
    const linkSsoBtn = document.getElementById('link-sso-btn');
    if (linkSsoBtn) {
        linkSsoBtn.addEventListener('click', () => {
            // Redirect to OIDC link endpoint
            window.location.href = `${API_URL}/api/auth/oidc/link`;
        });
    }

    const unlinkSsoBtn = document.getElementById('unlink-sso-btn');
    if (unlinkSsoBtn) {
        unlinkSsoBtn.addEventListener('click', handleUnlinkSso);
    }

    loadAccountInfo();
}

// Account password management
async function loadAccountInfo() {
    try {
        // Add cache-busting to ensure fresh data
        const response = await fetch(`${API_URL}/api/auth/account?_=${Date.now()}`);
        if (!response.ok) return;

        const account = await response.json();

        // Setup username input placeholder
        const usernameInput = document.getElementById('account-username');
        if (usernameInput) {
            usernameInput.placeholder = account.username;
        }

        // Show/hide username change based on admin setting
        const changeUsernameItem = document.getElementById('change-username-item');
        if (changeUsernameItem) {
            changeUsernameItem.style.display = account.allow_username_change ? '' : 'none';
        }

        // Password section - hide entirely if user can't change password
        const passwordHeading = document.getElementById('password-section-heading');
        const removePasswordItem = document.getElementById('remove-password-item');
        const changePasswordItem = document.getElementById('change-password-item');

        if (account.allow_password_change) {
            // Show password section
            if (passwordHeading) passwordHeading.style.display = '';
            if (changePasswordItem) changePasswordItem.style.display = '';

            // Update button text and description based on whether password is set
            const changePasswordBtn = document.getElementById('change-password-btn');
            const changePasswordDesc = changePasswordItem?.querySelector('.setting-description');
            const currentPasswordInput = document.getElementById('current-password-input');
            if (account.has_password) {
                if (changePasswordBtn) changePasswordBtn.textContent = 'Change Password';
                if (changePasswordDesc) changePasswordDesc.textContent = 'Set a new password for your account';
                if (currentPasswordInput) currentPasswordInput.style.display = '';
            } else {
                if (changePasswordBtn) changePasswordBtn.textContent = 'Set Password';
                if (changePasswordDesc) changePasswordDesc.textContent = 'Set a password for your account';
                if (currentPasswordInput) currentPasswordInput.style.display = 'none';
            }

            // Show remove password option only if user has password and it's not required
            if (removePasswordItem) {
                removePasswordItem.style.display = (account.has_password && !account.password_required) ? '' : 'none';
            }
        } else {
            // Hide entire password section
            if (passwordHeading) passwordHeading.style.display = 'none';
            if (changePasswordItem) changePasswordItem.style.display = 'none';
            if (removePasswordItem) removePasswordItem.style.display = 'none';
        }

        // Handle SSO linking section
        const ssoHeading = document.getElementById('sso-section-heading');
        const ssoItem = document.getElementById('sso-link-setting-item');
        const ssoStatus = document.getElementById('sso-link-status');
        const linkBtn = document.getElementById('link-sso-btn');
        const unlinkBtn = document.getElementById('unlink-sso-btn');

        // Check if OIDC is enabled and allowed for this user
        const oidcResponse = await fetch(`${API_URL}/api/auth/oidc/enabled`);
        const oidcData = await oidcResponse.json();

        if (oidcData.enabled && account.oidc_allowed) {
            if (ssoHeading) ssoHeading.style.display = '';
            if (ssoItem) ssoItem.style.display = '';

            if (account.oidc_provider) {
                ssoStatus.textContent = `Linked to ${account.oidc_provider}`;
                linkBtn.style.display = 'none';
                unlinkBtn.style.display = '';
            } else {
                ssoStatus.textContent = 'Not linked';
                linkBtn.textContent = `Link ${oidcData.providerName || 'SSO'} Account`;
                linkBtn.style.display = '';
                unlinkBtn.style.display = 'none';
            }
        } else {
            if (ssoHeading) ssoHeading.style.display = 'none';
            if (ssoItem) ssoItem.style.display = 'none';
        }
        // Check URL params for Ravelry connection result
        const urlParams = new URLSearchParams(window.location.hash.split('?')[1] || '');
        if (urlParams.get('ravelry') === 'connected') {
            showToast('Ravelry account connected successfully!', 'success');
            history.replaceState(null, '', window.location.pathname + '#settings/ravelry');
            // Auto-switch to Ravelry tab
            switchToSettingsSection('ravelry');
        }
    } catch (error) {
        console.error('Failed to load account info:', error);
    }
}

// ============ Ravelry Tab ============
const ravelryState = {
    activeTab: 'patterns',
    patterns: { items: [], page: 1, pageCount: 1, total: 0, loaded: false },
    yarn: { items: [], page: 1, pageCount: 1, total: 0, loaded: false },
    hooks: { items: [], total: 0, loaded: false },
    favorites: { items: [], page: 1, pageCount: 1, total: 0, loaded: false },
    selected: { patterns: new Set(), yarn: new Set(), hooks: new Set(), favorites: new Set() },
    importing: false,
    importingTab: null
};

let ravelryListenersAttached = false;
async function initRavelryTab() {
    // Check if Ravelry is enabled
    try {
        const enabledRes = await fetch(`${API_URL}/api/ravelry/enabled`);
        const enabledData = await enabledRes.json();
        const navBtn = document.getElementById('ravelry-nav-btn');
        if (!enabledData.enabled) {
            if (navBtn) navBtn.style.display = 'none';
            return;
        }
        if (navBtn) navBtn.style.display = '';
    } catch (e) {
        return;
    }

    // Check connection status
    try {
        const statusRes = await fetch(`${API_URL}/api/ravelry/status`);
        const statusData = await statusRes.json();

        const statusText = document.getElementById('ravelry-connection-status');
        const connectBtn = document.getElementById('ravelry-connect-btn');
        const disconnectBtn = document.getElementById('ravelry-disconnect-btn');
        const importArea = document.getElementById('ravelry-import-area');

        const refreshBtn = document.getElementById('ravelry-refresh-btn');

        if (statusData.connected) {
            if (statusText) statusText.textContent = `Connected as ${statusData.username}`;
            if (connectBtn) connectBtn.style.display = 'none';
            if (disconnectBtn) disconnectBtn.style.display = '';
            if (importArea) importArea.style.display = '';
            if (refreshBtn) refreshBtn.style.display = '';
            // Load all tabs in parallel
            loadRavelryTabData('patterns');
            loadRavelryTabData('yarn');
            loadRavelryTabData('hooks');
            loadRavelryTabData('favorites');
        } else {
            if (statusText) statusText.textContent = 'Not connected';
            if (connectBtn) connectBtn.style.display = '';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (importArea) importArea.style.display = 'none';
            if (refreshBtn) refreshBtn.style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to check Ravelry status:', e);
    }

    // Setup event listeners (only once)
    if (ravelryListenersAttached) return;
    ravelryListenersAttached = true;

    document.getElementById('ravelry-refresh-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const svg = btn.querySelector('svg');
        svg.style.animation = 'spin 0.8s linear infinite';
        btn.disabled = true;
        ravelryState.patterns.loaded = false;
        ravelryState.yarn.loaded = false;
        ravelryState.hooks.loaded = false;
        ravelryState.favorites.loaded = false;
        try {
            await Promise.all([
                loadRavelryTabData('patterns'),
                loadRavelryTabData('yarn'),
                loadRavelryTabData('hooks'),
                loadRavelryTabData('favorites')
            ]);
        } catch (err) {
            showToast(err.message || 'Failed to refresh Ravelry data', 'error');
        }
        svg.style.animation = '';
        btn.disabled = false;
    });

    document.getElementById('ravelry-connect-btn')?.addEventListener('click', () => {
        window.location.href = `${API_URL}/api/ravelry/auth`;
    });

    const disconnectBtn = document.getElementById('ravelry-disconnect-btn');
    let disconnectTimeout = null;
    disconnectBtn?.addEventListener('click', async () => {
        if (disconnectBtn.dataset.confirmed === 'true') {
            disconnectBtn.dataset.confirmed = '';
            disconnectBtn.textContent = 'Disconnect';
            clearTimeout(disconnectTimeout);
            try {
                const res = await fetch(`${API_URL}/api/ravelry/disconnect`, { method: 'POST' });
                if (res.ok) {
                    showToast('Ravelry account disconnected', 'success');
                    ravelryState.patterns.loaded = false;
                    ravelryState.yarn.loaded = false;
                    ravelryState.hooks.loaded = false;
                    initRavelryTab();
                }
            } catch (e) {
                showToast('Failed to disconnect', 'error');
            }
        } else {
            disconnectBtn.dataset.confirmed = 'true';
            disconnectBtn.textContent = 'Confirm Disconnect?';
            disconnectTimeout = setTimeout(() => {
                disconnectBtn.dataset.confirmed = '';
                disconnectBtn.textContent = 'Disconnect';
            }, 4000);
        }
    });

    // Sub-tab switching
    document.querySelectorAll('.ravelry-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.ravelryTab;
            ravelryState.activeTab = tabName;
            const tabsContainer = tab.closest('.ravelry-tabs');
            if (tabsContainer) {
                const tabLeft = tab.offsetLeft;
                const tabWidth = tab.offsetWidth;
                const containerWidth = tabsContainer.offsetWidth;
                tabsContainer.scrollTo({ left: tabLeft - (containerWidth / 2) + (tabWidth / 2), behavior: 'smooth' });
            }
            document.querySelectorAll('.ravelry-tab').forEach(t => t.classList.toggle('active', t === tab));
            document.querySelectorAll('.ravelry-list').forEach(l => {
                l.style.display = l.dataset.ravelryTab === tabName ? '' : 'none';
            });
            loadRavelryTabData(tabName);
            updateRavelrySelectAll();
            updateRavelryImportBtn();
            updateRavelryPagination();
            // Hide progress bar if it belongs to a different tab
            const progressArea = document.getElementById('ravelry-progress-area');
            if (progressArea && ravelryState.importing && ravelryState.importingTab !== tabName) {
                progressArea.style.display = 'none';
            } else if (progressArea && ravelryState.importing && ravelryState.importingTab === tabName) {
                progressArea.style.display = '';
            }
        });
    });

    // Swipe between Ravelry sub-tabs on mobile (stopPropagation prevents settings swipe from firing)
    const ravelryImportArea = document.getElementById('ravelry-import-area');
    if (ravelryImportArea) {
        const ravelryTabOrder = ['patterns', 'yarn', 'hooks', 'favorites'];
        let rSwipeStartX = null, rSwipeStartY = null;
        ravelryImportArea.addEventListener('touchstart', (e) => {
            if (e.target.closest('input, select, button, .ravelry-item-checkbox, .ravelry-select-all-cb')) return;
            rSwipeStartX = e.touches[0].clientX;
            rSwipeStartY = e.touches[0].clientY;
            e.stopPropagation();
        }, { passive: true });
        ravelryImportArea.addEventListener('touchend', (e) => {
            if (rSwipeStartX === null) return;
            const diffX = e.changedTouches[0].clientX - rSwipeStartX;
            const diffY = e.changedTouches[0].clientY - rSwipeStartY;
            rSwipeStartX = null;
            rSwipeStartY = null;
            if (Math.abs(diffX) < 60 || Math.abs(diffY) > Math.abs(diffX)) return;
            e.stopPropagation();
            const currentIdx = ravelryTabOrder.indexOf(ravelryState.activeTab);
            const nextIdx = diffX < 0 ? currentIdx + 1 : currentIdx - 1;
            if (nextIdx >= 0 && nextIdx < ravelryTabOrder.length) {
                document.querySelector(`.ravelry-tab[data-ravelry-tab="${ravelryTabOrder[nextIdx]}"]`)?.click();
            }
        }, { passive: true });
    }

    // Select all
    (document.getElementById('ravelry-select-all-wrap') || document.getElementById('ravelry-select-all'))?.addEventListener('click', () => {
        const tab = ravelryState.activeTab;
        const data = ravelryState[tab];
        const allSelected = data.items.length > 0 && data.items.every(i => ravelryState.selected[tab].has(i.id));
        if (allSelected) {
            ravelryState.selected[tab].clear();
        } else {
            data.items.forEach(item => {
                ravelryState.selected[tab].add(item.id);
            });
        }
        renderRavelryList(tab);
        updateRavelrySelectAll();
        updateRavelryImportBtn();
    });

    // Import selected
    document.getElementById('ravelry-import-selected-btn')?.addEventListener('click', () => {
        const tab = ravelryState.activeTab;
        const ids = Array.from(ravelryState.selected[tab]);
        if (ids.length === 0) return;
        let importIds = ids;
        if (tab === 'patterns' || tab === 'favorites') {
            const items = ravelryState[tab].items;
            const noPdf = ids.filter(id => {
                const item = items.find(i => i.id === id);
                return item && (tab === 'favorites' ? item.fav_type === 'pattern' : true) && !item.has_pdf;
            });
            if (noPdf.length > 0) {
                const msgs = noPdf.map(id => {
                    const item = items.find(i => i.id === id);
                    if (!item) return null;
                    const reason = item.pdf_status === 'purchase_required'
                        ? 'must be purchased on Ravelry before it can be imported'
                        : 'does not have a PDF — it may be a web-only pattern';
                    return `"${item.name}" ${reason}`;
                }).filter(Boolean).join('\n');
                showToast(msgs, 'error', 8000);
                importIds = ids.filter(id => !noPdf.includes(id));
                if (importIds.length === 0) return;
            }
        }
        startRavelryImport(tab, importIds);
    });

    // Import all (click once to confirm, click again to execute)
    const importAllBtn = document.getElementById('ravelry-import-all-btn');
    let importAllConfirmTimeout = null;
    importAllBtn?.addEventListener('click', () => {
        if (importAllBtn.dataset.confirmed === 'true') {
            importAllBtn.dataset.confirmed = '';
            importAllBtn.textContent = 'Import All';
            clearTimeout(importAllConfirmTimeout);
            startRavelryImport(ravelryState.activeTab, null);
        } else {
            importAllBtn.dataset.confirmed = 'true';
            importAllBtn.textContent = 'Confirm Import?';
            importAllConfirmTimeout = setTimeout(() => {
                importAllBtn.dataset.confirmed = '';
                importAllBtn.textContent = 'Import All';
            }, 4000);
        }
    });

    // Pagination
    document.getElementById('ravelry-prev-page')?.addEventListener('click', () => {
        const tab = ravelryState.activeTab;
        if (ravelryState[tab].page > 1) {
            ravelryState[tab].page--;
            ravelryState[tab].loaded = false;
            loadRavelryTabData(tab);
        }
    });

    document.getElementById('ravelry-next-page')?.addEventListener('click', () => {
        const tab = ravelryState.activeTab;
        if (ravelryState[tab].page < ravelryState[tab].pageCount) {
            ravelryState[tab].page++;
            ravelryState[tab].loaded = false;
            loadRavelryTabData(tab);
        }
    });
}

async function loadRavelryTabData(tab) {
    const data = ravelryState[tab];
    if (data.loaded) return;

    const listEl = document.getElementById(`ravelry-${tab}-list`);
    if (listEl) listEl.innerHTML = '<div class="ravelry-loading">Loading...</div>';

    try {
        let url;
        if (tab === 'patterns') {
            url = `${API_URL}/api/ravelry/library?page=${data.page}&page_size=50`;
        } else if (tab === 'yarn') {
            url = `${API_URL}/api/ravelry/stash?page=${data.page}&page_size=50`;
        } else if (tab === 'favorites') {
            url = `${API_URL}/api/ravelry/favorites?page=${data.page}&page_size=50`;
        } else {
            url = `${API_URL}/api/ravelry/needles`;
        }

        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (res.status === 401) {
                // Token expired — show reconnect prompt
                if (listEl) listEl.innerHTML = '<div class="ravelry-loading">Session expired. Please disconnect and reconnect your Ravelry account.</div>';
                showToast('Ravelry session expired. Please reconnect.', 'error');
                return;
            }
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const result = await res.json();

        data.items = result.items || [];
        data.total = result.total || 0;
        if (result.page_count) data.pageCount = result.page_count;
        data.loaded = true;

        // Update tab count
        const countEl = document.getElementById(`ravelry-${tab}-total`);
        if (countEl) countEl.textContent = `(${data.total})`;

        renderRavelryList(tab);
        updateRavelryPagination();
        updateRavelrySelectAll();
        updateRavelryImportBtn();
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div class="ravelry-loading">Failed to load. Try again.</div>';
    }
}

function renderRavelryList(tab) {
    const listEl = document.getElementById(`ravelry-${tab}-list`);
    if (!listEl) return;

    const data = ravelryState[tab];
    if (data.items.length === 0) {
        listEl.innerHTML = '<div class="ravelry-empty">No items found on Ravelry</div>';
        return;
    }

    const selected = ravelryState.selected[tab];
    const checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    let html = '';

    if (tab === 'patterns') {
        for (const item of data.items) {
            const sel = selected.has(item.id) ? ' selected' : '';
            const pdfBadge = item.has_pdf
                ? '<span class="ravelry-badge ravelry-badge-pdf">PDF available</span>'
                : item.pdf_status === 'purchase_required'
                    ? '<span class="ravelry-badge ravelry-badge-no-pdf" title="This pattern has a PDF but must be purchased on Ravelry first">Purchase required</span>'
                    : '<span class="ravelry-badge ravelry-badge-no-pdf" title="This pattern does not have a PDF available">No PDF</span>';
            const importedBadge = item.imported ? '<span class="ravelry-badge ravelry-badge-imported">Imported</span>' : '';
            html += `<div class="ravelry-item${sel}" data-id="${item.id}">
                <div class="ravelry-item-checkbox" data-ravelry-id="${item.id}">${checkSvg}</div>
                <div class="ravelry-item-photo">${item.photo ? `<img src="${item.photo}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ravelry-item-photo-placeholder"><img src="${API_URL}/icons/crocheting.svg" width="28" height="28" alt=""></div>`}</div>
                <div class="ravelry-item-info">
                    <div class="ravelry-item-name">${escapeHtml(item.name)}</div>
                    <div class="ravelry-item-meta">${escapeHtml(item.author)}${item.category ? ` &middot; ${escapeHtml(item.category)}` : ''}</div>
                </div>
                <div class="ravelry-item-badges">${pdfBadge}${importedBadge}</div>
            </div>`;
        }
    } else if (tab === 'yarn') {
        for (const item of data.items) {
            const sel = selected.has(item.id) ? ' selected' : '';
            const importedBadge = item.imported ? '<span class="ravelry-badge ravelry-badge-imported">Imported</span>' : '';
            html += `<div class="ravelry-item${sel}" data-id="${item.id}">
                <div class="ravelry-item-checkbox" data-ravelry-id="${item.id}">${checkSvg}</div>
                <div class="ravelry-item-photo">${item.photo ? `<img src="${item.photo}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="ravelry-item-photo-placeholder"><svg viewBox="5 18 90 67" fill="currentColor"><path d="M47.6,34.1c-1.4,1-2.7,2.1-4.1,3.3c5.1,4.4,12.8,15.9,13.9,29c1.8-2.1,3.2-4.6,4.3-7.2C59.6,46.6,51.3,36.3,47.6,34.1z"/><path d="M45.2,60.8c-6.4,4.9-14,8.3-21,9.4v0c-0.2,1-0.3,2-0.4,2.9c1.2,0.6,2.4,1.1,3.6,1.6c8.2-1,15.4-5.1,19.3-7.8C46.4,64.8,45.8,62.7,45.2,60.8z"/><path d="M34.6,47.6c-2.6,3.4-4.6,6.9-6.2,10.2c4.3-1.7,8.6-4.2,12.2-7.1c-1.4-2.3-2.8-4.2-4-5.7C35.9,45.8,35.2,46.7,34.6,47.6z"/><path d="M44.8,23.1c-2.7-0.9-5.7-1.4-8.7-1.3c-4.9,3.3-9.5,8-14.3,14.4c-6.4,8.5-9.4,17.1-10.5,23.3c0.9,2.2,2.1,4.3,3.6,6.1c1-6.7,4.2-16,11.1-25.2C32.3,32.1,38.3,26.5,44.8,23.1z"/><path d="M53.3,27.6c-1.5-1.2-3.2-2.3-5-3.1c-7,3-13.4,8.6-20.1,17.5c-7.5,10-10.4,20.2-10.9,26.4c1.2,1.2,2.5,2.2,3.9,3.2c0.9-6.7,4.1-16.3,11.2-25.7C39.3,36.7,46,30.9,53.3,27.6z"/><path d="M63.3,53.9c0.4-2.1,0.5-4.4,0.4-6.6c-0.5-6.9-3.5-13.1-8.1-17.6c-1.9,0.7-3.8,1.7-5.6,2.8C54.1,35.6,60.3,43.7,63.3,53.9z"/><path d="M30.8,22.4C17.8,25.2,8.4,37.2,9.3,50.9c0.1,1.1,0.2,2.2,0.4,3.3c1.7-5.8,4.7-12.8,9.9-19.6C23.4,29.6,27.1,25.5,30.8,22.4z"/><path d="M33.9,76.2c1.4,0.1,2.9,0.2,4.4,0.1c3.1-0.2,6-0.9,8.8-2.1c0.1-1.4,0.1-2.8,0-4.2C43.9,72,39.3,74.6,33.9,76.2z"/><path d="M24.8,67.3c6.5-1.2,13.5-4.5,19.4-9.2l0,0c-0.7-1.8-1.5-3.5-2.3-5c-4.5,3.5-9.9,6.4-15.1,8.1C26,63.4,25.3,65.4,24.8,67.3z"/><path d="M91.6,80c-4.1-7.4-7.4-10.9-14.6-10.6c-2.8,0.1-5.4,1.8-8.2,3.7c-4,2.6-7.8,5.1-11.7,3c-1-0.6-1.7-1.5-2.2-2.4c-0.9,0.7-1.8,1.3-2.8,1.9c0.7,1.3,1.8,2.6,3.4,3.5c5.7,3.1,10.9-0.4,15.2-3.1c2.4-1.6,4.7-3.1,6.5-3.1c5.5-0.2,7.7,2.1,11.6,8.9c0.4,0.8,1.5,1.1,2.3,0.6C91.7,81.8,92,80.8,91.6,80z"/><path d="M50.1,72.7c0.4-0.2,0.4-0.3,0.8-0.5c0,0,0,0,0,0c0,0,0,0.1,0,0.1c1-0.7,2.1-1.4,3.1-2.3c0,0,0-0.1,0-0.1c0.3-0.2,0.6-0.5,0.9-0.7c-0.2-12.9-8-25.4-13.3-29.8c-1.1,1.1-2.1,2.2-3.2,3.5c5.5,6.3,10.7,16.6,11.4,27.1C49.8,70.9,50.1,71.7,50.1,72.7z"/></svg></div>'}</div>
                <div class="ravelry-item-info">
                    <div class="ravelry-item-name">${escapeHtml(item.name)}</div>
                    <div class="ravelry-item-meta">${escapeHtml(item.brand)}${item.colorway ? ` &middot; ${escapeHtml(item.colorway)}` : ''}${item.weight ? ` &middot; ${escapeHtml(item.weight)}` : ''}</div>
                    <div class="ravelry-item-meta">${item.skeins} skein${item.skeins !== 1 ? 's' : ''}</div>
                </div>
                <div class="ravelry-item-badges">${importedBadge}</div>
            </div>`;
        }
    } else if (tab === 'favorites') {
        for (const item of data.items) {
            const sel = selected.has(item.id) ? ' selected' : '';
            const importedBadge = item.imported ? '<span class="ravelry-badge ravelry-badge-imported">Imported</span>' : '';
            const typeBadge = `<span class="ravelry-badge" style="background: var(--text-muted); color: var(--bg-color);">${item.fav_type === 'pattern' ? 'Pattern' : 'Yarn'}</span>`;
            const pdfBadge = item.fav_type !== 'pattern' ? '' : item.has_pdf
                ? '<span class="ravelry-badge ravelry-badge-pdf">PDF available</span>'
                : '<span class="ravelry-badge ravelry-badge-no-pdf">No PDF</span>';
            const placeholder = item.fav_type === 'yarn'
                ? '<div class="ravelry-item-photo-placeholder"><svg viewBox="5 18 90 67" fill="currentColor"><path d="M47.6,34.1c-1.4,1-2.7,2.1-4.1,3.3c5.1,4.4,12.8,15.9,13.9,29c1.8-2.1,3.2-4.6,4.3-7.2C59.6,46.6,51.3,36.3,47.6,34.1z"/><path d="M45.2,60.8c-6.4,4.9-14,8.3-21,9.4v0c-0.2,1-0.3,2-0.4,2.9c1.2,0.6,2.4,1.1,3.6,1.6c8.2-1,15.4-5.1,19.3-7.8C46.4,64.8,45.8,62.7,45.2,60.8z"/><path d="M34.6,47.6c-2.6,3.4-4.6,6.9-6.2,10.2c4.3-1.7,8.6-4.2,12.2-7.1c-1.4-2.3-2.8-4.2-4-5.7C35.9,45.8,35.2,46.7,34.6,47.6z"/><path d="M44.8,23.1c-2.7-0.9-5.7-1.4-8.7-1.3c-4.9,3.3-9.5,8-14.3,14.4c-6.4,8.5-9.4,17.1-10.5,23.3c0.9,2.2,2.1,4.3,3.6,6.1c1-6.7,4.2-16,11.1-25.2C32.3,32.1,38.3,26.5,44.8,23.1z"/><path d="M53.3,27.6c-1.5-1.2-3.2-2.3-5-3.1c-7,3-13.4,8.6-20.1,17.5c-7.5,10-10.4,20.2-10.9,26.4c1.2,1.2,2.5,2.2,3.9,3.2c0.9-6.7,4.1-16.3,11.2-25.7C39.3,36.7,46,30.9,53.3,27.6z"/><path d="M63.3,53.9c0.4-2.1,0.5-4.4,0.4-6.6c-0.5-6.9-3.5-13.1-8.1-17.6c-1.9,0.7-3.8,1.7-5.6,2.8C54.1,35.6,60.3,43.7,63.3,53.9z"/><path d="M30.8,22.4C17.8,25.2,8.4,37.2,9.3,50.9c0.1,1.1,0.2,2.2,0.4,3.3c1.7-5.8,4.7-12.8,9.9-19.6C23.4,29.6,27.1,25.5,30.8,22.4z"/><path d="M33.9,76.2c1.4,0.1,2.9,0.2,4.4,0.1c3.1-0.2,6-0.9,8.8-2.1c0.1-1.4,0.1-2.8,0-4.2C43.9,72,39.3,74.6,33.9,76.2z"/><path d="M24.8,67.3c6.5-1.2,13.5-4.5,19.4-9.2l0,0c-0.7-1.8-1.5-3.5-2.3-5c-4.5,3.5-9.9,6.4-15.1,8.1C26,63.4,25.3,65.4,24.8,67.3z"/><path d="M91.6,80c-4.1-7.4-7.4-10.9-14.6-10.6c-2.8,0.1-5.4,1.8-8.2,3.7c-4,2.6-7.8,5.1-11.7,3c-1-0.6-1.7-1.5-2.2-2.4c-0.9,0.7-1.8,1.3-2.8,1.9c0.7,1.3,1.8,2.6,3.4,3.5c5.7,3.1,10.9-0.4,15.2-3.1c2.4-1.6,4.7-3.1,6.5-3.1c5.5-0.2,7.7,2.1,11.6,8.9c0.4,0.8,1.5,1.1,2.3,0.6C91.7,81.8,92,80.8,91.6,80z"/><path d="M50.1,72.7c0.4-0.2,0.4-0.3,0.8-0.5c0,0,0,0,0,0c0,0,0,0.1,0,0.1c1-0.7,2.1-1.4,3.1-2.3c0,0,0-0.1,0-0.1c0.3-0.2,0.6-0.5,0.9-0.7c-0.2-12.9-8-25.4-13.3-29.8c-1.1,1.1-2.1,2.2-3.2,3.5c5.5,6.3,10.7,16.6,11.4,27.1C49.8,70.9,50.1,71.7,50.1,72.7z"/></svg></div>'
                : `<div class="ravelry-item-photo-placeholder"><img src="${API_URL}/icons/crocheting.svg" width="28" height="28" alt=""></div>`;
            const metaParts = [];
            if (item.fav_type === 'pattern') {
                if (item.author) metaParts.push(escapeHtml(item.author));
                if (item.category) metaParts.push(escapeHtml(item.category));
            } else {
                if (item.brand) metaParts.push(escapeHtml(item.brand));
                if (item.colorway) metaParts.push(escapeHtml(item.colorway));
                if (item.weight) metaParts.push(escapeHtml(item.weight));
            }
            html += `<div class="ravelry-item${sel}" data-id="${item.id}">
                <div class="ravelry-item-checkbox" data-ravelry-id="${item.id}">${checkSvg}</div>
                <div class="ravelry-item-photo">${item.photo ? `<img src="${item.photo}" alt="" loading="lazy" referrerpolicy="no-referrer">` : placeholder}</div>
                <div class="ravelry-item-info">
                    <div class="ravelry-item-name">${escapeHtml(item.name)}</div>
                    ${metaParts.length > 0 ? `<div class="ravelry-item-meta">${metaParts.join(' &middot; ')}</div>` : ''}
                    ${item.fav_type === 'yarn' && item.skeins ? `<div class="ravelry-item-meta">${item.skeins} skein${item.skeins !== 1 ? 's' : ''}</div>` : ''}
                </div>
                <div class="ravelry-item-badges">${typeBadge}${pdfBadge}${importedBadge}</div>
            </div>`;
        }
    } else {
        for (const item of data.items) {
            const sel = selected.has(item.id) ? ' selected' : '';
            const importedBadge = item.imported ? '<span class="ravelry-badge ravelry-badge-imported">Imported</span>' : '';
            const metaParts = [];
            if (item.type) metaParts.push(escapeHtml(item.type));
            if (item.size) metaParts.push(escapeHtml(item.size));
            if (item.length) metaParts.push(escapeHtml(item.length));
            if (item.material) metaParts.push(escapeHtml(item.material));
            const metaLine = metaParts.join(' &middot; ');
            const hookPlaceholder = `<div class="ravelry-item-photo-placeholder">${hookPlaceholderSvg(item.is_hook ? 'crochet' : 'knitting', 40)}</div>`;
            html += `<div class="ravelry-item${sel}" data-id="${item.id}">
                <div class="ravelry-item-checkbox" data-ravelry-id="${item.id}">${checkSvg}</div>
                <div class="ravelry-item-photo">${hookPlaceholder}</div>
                <div class="ravelry-item-info">
                    <div class="ravelry-item-name">${escapeHtml(item.name)}</div>
                    ${metaLine ? `<div class="ravelry-item-meta">${metaLine}</div>` : ''}
                    ${item.comment ? `<div class="ravelry-item-meta">${escapeHtml(item.comment)}</div>` : ''}
                </div>
                <div class="ravelry-item-badges">${importedBadge}</div>
            </div>`;
        }
    }

    listEl.innerHTML = html;

    // Add click listeners for checkbox divs
    listEl.querySelectorAll('.ravelry-item-checkbox').forEach(cb => {
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = parseInt(cb.dataset.ravelryId);
            const item = cb.closest('.ravelry-item');
            if (selected.has(id)) {
                selected.delete(id);
                item.classList.remove('selected');
            } else {
                selected.add(id);
                item.classList.add('selected');
            }
            updateRavelrySelectAll();
            updateRavelryImportBtn();
        });
    });

    // Also toggle on row click
    listEl.querySelectorAll('.ravelry-item').forEach(row => {
        row.addEventListener('click', () => {
            const id = parseInt(row.dataset.id);
            if (selected.has(id)) {
                selected.delete(id);
                row.classList.remove('selected');
            } else {
                selected.add(id);
                row.classList.add('selected');
            }
            updateRavelrySelectAll();
            updateRavelryImportBtn();
        });
    });
}

function updateRavelrySelectAll() {
    const tab = ravelryState.activeTab;
    const data = ravelryState[tab];
    const selected = ravelryState.selected[tab];
    const selectAllEl = document.getElementById('ravelry-select-all');
    if (selectAllEl) {
        const allSelected = data.items.length > 0 && data.items.every(i => selected.has(i.id));
        const someSelected = data.items.some(i => selected.has(i.id));
        selectAllEl.classList.toggle('checked', allSelected);
        selectAllEl.classList.toggle('indeterminate', someSelected && !allSelected);
    }
}

function updateRavelryImportBtn() {
    const tab = ravelryState.activeTab;
    const btn = document.getElementById('ravelry-import-selected-btn');
    const selected = ravelryState.selected[tab];
    const count = selected.size;
    if (btn) {
        btn.disabled = count === 0 || ravelryState.importing;
        const hasImported = ravelryState[tab].items.some(i => selected.has(i.id) && i.imported);
        const allImported = count > 0 && ravelryState[tab].items.filter(i => selected.has(i.id)).every(i => i.imported);
        const label = allImported ? 'Re-Import' : hasImported ? 'Import / Re-Import' : 'Import';
        btn.textContent = count > 0 ? `${label} Selected (${count})` : 'Import Selected';
    }
}

function updateRavelryPagination() {
    const tab = ravelryState.activeTab;
    const data = ravelryState[tab];
    const paginationEl = document.getElementById('ravelry-pagination');
    if (!paginationEl) return;

    if (tab === 'hooks' || data.pageCount <= 1) {
        paginationEl.style.display = 'none';
        return;
    }

    paginationEl.style.display = '';
    document.getElementById('ravelry-prev-page').disabled = data.page <= 1;
    document.getElementById('ravelry-next-page').disabled = data.page >= data.pageCount;
    document.getElementById('ravelry-page-info').textContent = `Page ${data.page} of ${data.pageCount}`;
}

async function startRavelryImport(tab, ids) {
    ravelryState.importing = true;
    ravelryState.importingTab = tab;
    const progressArea = document.getElementById('ravelry-progress-area');
    const progressText = document.getElementById('ravelry-progress-text');
    const progressBar = document.getElementById('ravelry-progress-bar');
    const importSelectedBtn = document.getElementById('ravelry-import-selected-btn');
    const importAllBtn = document.getElementById('ravelry-import-all-btn');

    if (progressArea) progressArea.style.display = '';
    if (progressText) progressText.textContent = 'Starting import...';
    if (progressBar) progressBar.style.width = '10%';
    if (importSelectedBtn) importSelectedBtn.disabled = true;
    if (importAllBtn) importAllBtn.disabled = true;

    const body = {};
    if (tab === 'favorites') {
        // Split favorites into patterns and yarns by looking up fav_type
        const favItems = ravelryState.favorites.items;
        const selectedFavs = ids ? favItems.filter(f => ids.includes(f.id)) : favItems;
        const patternIds = selectedFavs.filter(f => f.fav_type === 'pattern' && f.pattern_id).map(f => f.pattern_id);
        const yarnFavs = selectedFavs.filter(f => f.fav_type === 'yarn' && f.yarn_id);
        if (patternIds.length > 0) {
            body.importPatterns = true;
            body.patternIds = patternIds;
        }
        if (yarnFavs.length > 0) {
            body.importYarns = true;
            body.favoriteYarnIds = yarnFavs.map(f => f.yarn_id);
        }
        if (!body.importPatterns && !body.importYarns) {
            if (progressArea) progressArea.style.display = 'none';
            if (importSelectedBtn) importSelectedBtn.disabled = false;
            if (importAllBtn) importAllBtn.disabled = false;
            ravelryState.importing = false;
            return;
        }
    } else if (tab === 'patterns') {
        body.importPatterns = true;
        if (ids) body.patternIds = ids;
    } else if (tab === 'yarn') {
        body.importYarns = true;
        if (ids) body.yarnIds = ids;
    } else {
        body.importHooks = true;
        if (ids) body.hookIds = ids;
    }

    try {
        const resp = await fetch(`${API_URL}/api/ravelry/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (resp.ok) {
            if (progressText) progressText.textContent = 'Importing...';
            // Poll for progress instead of relying on SSE
            const pollInterval = setInterval(async () => {
                try {
                    const statusResp = await fetch(`${API_URL}/api/ravelry/import-status`);
                    const status = await statusResp.json();
                    if (progressText) progressText.textContent = status.status || 'Importing...';
                    if (progressBar && status.total > 0) {
                        const pct = Math.round((status.current / status.total) * 100);
                        progressBar.style.width = Math.max(pct, 5) + '%';
                    }
                    if (!status.active) {
                        clearInterval(pollInterval);
                        if (status.status === 'complete') {
                            showToast('Ravelry import complete!', 'success');
                            handleRavelryImportComplete(status);
                        } else if (status.status === 'error') {
                            if (progressText) progressText.textContent = `Import error: ${status.error}`;
                            ravelryState.importing = false;
                            if (importSelectedBtn) importSelectedBtn.disabled = false;
                            if (importAllBtn) importAllBtn.disabled = false;
                            showToast('Ravelry import failed', 'error');
                        }
                    }
                } catch (e) { /* keep polling */ }
            }, 1000);
        }
    } catch (error) {
        if (progressText) progressText.textContent = 'Failed to start import';
        showToast('Failed to start Ravelry import', 'error');
        ravelryState.importing = false;
        if (importSelectedBtn) importSelectedBtn.disabled = false;
        if (importAllBtn) importAllBtn.disabled = false;
    }
}

function handleRavelryImportComplete(data) {
    ravelryState.importing = false;
    ravelryState.importingTab = null;
    const progressText = document.getElementById('ravelry-progress-text');
    const progressBar = document.getElementById('ravelry-progress-bar');
    const importSelectedBtn = document.getElementById('ravelry-import-selected-btn');
    const importAllBtn = document.getElementById('ravelry-import-all-btn');

    const tab = ravelryState.activeTab;
    let count, label;
    if (tab === 'favorites') {
        count = (data.patterns || 0) + (data.yarns || 0);
        label = 'item';
    } else {
        count = tab === 'patterns' ? data.patterns : tab === 'yarn' ? data.yarns : data.hooks;
        label = tab === 'patterns' ? 'pattern' : tab === 'yarn' ? 'yarn' : 'hook/needle';
    }
    if (progressText) progressText.textContent = `Import complete! ${count} ${label}${count !== 1 ? 's' : ''} imported.`;
    if (progressBar) progressBar.style.width = '100%';
    if (importSelectedBtn) importSelectedBtn.disabled = false;
    if (importAllBtn) importAllBtn.disabled = false;

    // Clear selections and reload data
    ravelryState.selected.patterns.clear();
    ravelryState.selected.yarn.clear();
    ravelryState.selected.hooks.clear();
    ravelryState.selected.favorites.clear();
    ravelryState.patterns.loaded = false;
    ravelryState.yarn.loaded = false;
    ravelryState.hooks.loaded = false;
    ravelryState.favorites.loaded = false;
    loadRavelryTabData(ravelryState.activeTab);

    // Hide progress after a delay
    setTimeout(() => {
        const progressArea = document.getElementById('ravelry-progress-area');
        if (progressArea) progressArea.style.display = 'none';
        const progressBarEl = document.getElementById('ravelry-progress-bar');
        if (progressBarEl) progressBarEl.style.width = '0%';
    }, 5000);

    // Refresh main lists
    if (typeof loadPatterns === 'function') loadPatterns();
    if (typeof loadYarns === 'function') loadYarns();
    if (typeof loadHooks === 'function') loadHooks();
}

async function previewRavelryUrl() {
    const input = document.getElementById('ravelry-url-input');
    const status = document.getElementById('ravelry-url-status');
    const previewBtn = document.getElementById('preview-ravelry-url');
    const url = input?.value?.trim();

    if (!url) { showToast('Please enter a Ravelry URL', 'error'); return; }
    if (!url.includes('ravelry.com/patterns/')) { showToast('Please enter a valid Ravelry pattern URL', 'error'); return; }

    if (status) status.style.display = 'none';
    if (previewBtn) { previewBtn.disabled = true; previewBtn.textContent = 'Looking up...'; }

    try {
        const response = await fetch(`${API_URL}/api/ravelry/preview-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        let data;
        try { data = await response.json(); } catch { data = {}; }

        if (!response.ok) {
            if (status) { status.style.display = ''; status.textContent = data.error || 'Failed to look up pattern'; }
            if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = 'Next'; }
            return;
        }

        if (!data.hasPdf) {
            if (status) { status.style.display = ''; status.textContent = `No PDF for "${data.name}". Purchase it on Ravelry or add it to your library first.`; }
            if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = 'Next'; }
            return;
        }

        // Populate step 2
        const thumbEl = document.getElementById('ravelry-preview-thumb');
        const pdfNoteEl = document.getElementById('ravelry-preview-pdf-note');
        const nameInput = document.getElementById('ravelry-import-name');
        const descInput = document.getElementById('ravelry-import-description');
        const categorySelect = document.getElementById('ravelry-import-category');
        const ratingEl = document.getElementById('ravelry-import-rating');
        const favBtn = document.getElementById('ravelry-import-favorite-btn');

        if (thumbEl) {
            if (data.thumbnailUrl) { thumbEl.src = data.thumbnailUrl; thumbEl.style.display = ''; }
            else thumbEl.style.display = 'none';
        }
        if (pdfNoteEl) {
            pdfNoteEl.textContent = data.hasPdf ? '📄 PDF available' : 'No PDF — metadata only';
            pdfNoteEl.className = 'ravelry-preview-pdf-note' + (data.hasPdf ? ' has-pdf' : ' no-pdf');
        }
        if (nameInput) nameInput.value = data.name || '';
        if (descInput) descInput.value = data.description || '';

        // Category: user's own categories, default to their default
        if (categorySelect) {
            categorySelect.innerHTML = '';
            const cats = allCategories.length > 0 ? allCategories : ['Uncategorized'];
            const defaultCat = getDefaultCategory();
            cats.forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.textContent = cat;
                if (cat === defaultCat) opt.selected = true;
                categorySelect.appendChild(opt);
            });
        }

        // Rating stars (pre-fill from Ravelry average if available)
        if (ratingEl) ratingEl.innerHTML = ratingInputHtml('ravelry-import-rating-input', data.rating || 0);

        // Reset status fields
        const isCurrentEl = document.getElementById('ravelry-import-is-current');
        if (isCurrentEl) isCurrentEl.checked = false;
        if (favBtn) {
            favBtn.classList.remove('active');
            const favSvg = favBtn.querySelector('svg');
            if (favSvg) { favSvg.setAttribute('fill', 'none'); favSvg.setAttribute('stroke', 'currentColor'); }
        }

        // Full hashtag selector — pre-select #ravelry if it exists
        const hashtagContainer = document.getElementById('ravelry-import-hashtags-container');
        const ravelryTag = allHashtags.find(h => h.name === 'ravelry');
        const preSelected = ravelryTag ? [ravelryTag.id] : [];
        if (hashtagContainer) hashtagContainer.innerHTML = createHashtagSelector('ravelry-import-hashtags', preSelected);

        // Ravelry suggested tags as quick-add chips
        const tagsContainer = document.getElementById('ravelry-suggested-tags');
        if (tagsContainer) {
            tagsContainer.innerHTML = '';
            (data.suggestedTags || []).forEach(tag => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'ravelry-tag-chip';
                chip.dataset.tag = tag;
                chip.textContent = tag;
                chip.addEventListener('click', () => chip.classList.toggle('active'));
                tagsContainer.appendChild(chip);
            });
            const tagRow = document.getElementById('ravelry-tags-row');
            if (tagRow) tagRow.style.display = data.suggestedTags?.length ? '' : 'none';
        }

        // warn if already in library
        const duplicateWarning = document.getElementById('ravelry-duplicate-warning');
        if (duplicateWarning) duplicateWarning.style.display = data.alreadyExists ? '' : 'none';
        if (nameInput && data.alreadyExists) nameInput.dataset.alreadyExists = 'true';
        else if (nameInput) delete nameInput.dataset.alreadyExists;

        // Switch to step 2
        document.getElementById('ravelry-url-step1').style.display = 'none';
        document.getElementById('ravelry-url-step2').style.display = '';
        document.getElementById('ravelry-url-back').style.display = '';

    } catch (error) {
        console.error('Ravelry preview error:', error);
        if (status) { status.style.display = ''; status.textContent = error.message || 'Failed to look up pattern. Please try again.'; }
        if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = 'Next'; }
    }
}

async function handleRavelryUrlImport() {
    const input = document.getElementById('ravelry-url-input');
    const status = document.getElementById('ravelry-import-status');
    const submitBtn = document.getElementById('submit-ravelry-url');
    const url = input?.value?.trim();
    const nameEl = document.getElementById('ravelry-import-name');
    const baseName = nameEl?.value?.trim();
    const name = nameEl?.dataset.alreadyExists ? `${baseName} (Copy)` : baseName;
    const category = document.getElementById('ravelry-import-category')?.value;
    const description = document.getElementById('ravelry-import-description')?.value?.trim();
    const isCurrent = document.getElementById('ravelry-import-is-current')?.checked || false;
    const isFavorite = document.getElementById('ravelry-import-favorite-btn')?.classList.contains('active') || false;
    const rating = parseInt(document.getElementById('ravelry-import-rating-input')?.dataset.rating) || 0;
    const hashtagIds = getSelectedHashtagIds('ravelry-import-hashtags');
    const tagNames = Array.from(document.querySelectorAll('#ravelry-suggested-tags .ravelry-tag-chip.active'))
        .map(el => el.dataset.tag);

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Importing...'; }
    if (status) { status.style.display = ''; status.textContent = 'Downloading pattern...'; }

    const progressWrap = document.getElementById('ravelry-url-progress');
    const progressBar = document.getElementById('ravelry-url-progress-bar');
    if (progressWrap) progressWrap.style.display = '';
    if (progressBar) progressBar.style.width = '15%';

    const steps = [
        { text: 'Downloading pattern...', pct: '15%' },
        { text: 'Fetching PDF...', pct: '45%' },
        { text: 'Processing...', pct: '75%' }
    ];
    let stepIdx = 0;
    const stepInterval = setInterval(() => {
        stepIdx++;
        if (stepIdx < steps.length) {
            if (status) status.textContent = steps[stepIdx].text;
            if (progressBar) progressBar.style.width = steps[stepIdx].pct;
        }
    }, 2500);

    try {
        const response = await fetch(`${API_URL}/api/ravelry/import-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, name, category, description, isCurrent, isFavorite, rating, hashtagIds, tagNames })
        });

        clearInterval(stepInterval);
        if (progressBar) progressBar.style.width = '100%';
        const data = await response.json();

        if (!response.ok) {
            if (status) { status.style.display = ''; status.style.color = 'var(--danger-color)'; status.textContent = data.error || 'Import failed'; }
            if (progressWrap) progressWrap.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Import'; }
            return;
        }

        if (data.alreadyExists) {
            showToast(`"${data.name || 'Pattern'}" is already in your library`, 'info');
        } else {
            const pdfNote = data.hasPdf ? ' (with PDF)' : ' (metadata only)';
            showToast(`Imported "${data.name}"${pdfNote}`, 'success');
        }

        document.getElementById('ravelry-url-modal').style.display = 'none';
        if (typeof loadPatterns === 'function') loadPatterns();
    } catch (error) {
        clearInterval(stepInterval);
        if (status) status.textContent = 'Failed to import. Please try again.';
        if (progressWrap) progressWrap.style.display = 'none';
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Import'; }
    }
}

async function handleRemoveOwnPassword() {
    const currentPassword = document.getElementById('remove-password-input').value;
    if (!currentPassword) {
        showToast('Please enter your current password', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/auth/remove-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword })
        });

        if (response.ok) {
            showToast('Password removed - you can now login with just your username');
            // Reset and hide the form
            document.getElementById('remove-password-input').value = '';
            document.getElementById('remove-password-form').style.display = 'none';
            document.getElementById('remove-password-btn').style.display = '';
            document.getElementById('remove-password-item').classList.remove('expanded');
            loadAccountInfo();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to remove password', 'error');
        }
    } catch (error) {
        console.error('Failed to remove password:', error);
        showToast('Failed to remove password', 'error');
    }
}

async function handleUnlinkSso() {
    if (!confirm('Are you sure you want to unlink your SSO account? You will need to use your username/password to login.')) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/auth/oidc/unlink`, {
            method: 'POST'
        });

        if (response.ok) {
            showToast('SSO account unlinked');
            loadAccountInfo();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to unlink SSO account', 'error');
        }
    } catch (error) {
        console.error('Failed to unlink SSO:', error);
        showToast('Failed to unlink SSO account', 'error');
    }
}

async function handleChangePassword() {
    const currentPassword = document.getElementById('current-password-input').value;
    const newPassword = document.getElementById('new-password-input').value;
    const confirmPassword = document.getElementById('confirm-password-input').value;

    if (!newPassword) {
        showToast('New password cannot be empty', 'error');
        return;
    }

    if (newPassword !== confirmPassword) {
        showToast('Passwords do not match', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/auth/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });

        if (response.ok) {
            showToast('Password updated successfully');
            // Reset and hide the form
            document.getElementById('change-password-form').querySelectorAll('input').forEach(i => i.value = '');
            document.getElementById('change-password-form').style.display = 'none';
            document.getElementById('change-password-btn').style.display = '';
            document.getElementById('change-password-item').classList.remove('expanded');
            loadAccountInfo();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to change password', 'error');
        }
    } catch (error) {
        console.error('Failed to change password:', error);
        showToast('Failed to change password', 'error');
    }
}

async function handleChangeUsername() {
    const usernameInput = document.getElementById('account-username');
    const newUsername = usernameInput?.value?.trim();

    if (!newUsername) {
        showToast('Username cannot be empty', 'error');
        return;
    }

    if (newUsername === currentUser?.username) {
        showToast('That is already your username', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/auth/account`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: newUsername })
        });

        if (response.ok) {
            showToast('Username updated');
            // Update current user info display
            if (currentUser) {
                currentUser.username = newUsername;
                const userInfo = document.getElementById('current-user-info');
                if (userInfo) {
                    userInfo.textContent = `${newUsername} (${currentUser.role})`;
                }
            }
            usernameInput.value = '';
            usernameInput.placeholder = newUsername;
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to change username', 'error');
        }
    } catch (error) {
        console.error('Failed to change username:', error);
        showToast('Failed to change username', 'error');
    }
}

// OIDC settings functions
async function loadOIDCSettings() {
    try {
        // Set callback URL automatically
        const callbackUrl = `${window.location.origin}/api/auth/oidc/callback`;
        document.getElementById('oidc-callback-url').textContent = callbackUrl;

        const response = await fetch(`${API_URL}/api/auth/oidc/settings`);
        if (response.ok) {
            const settings = await response.json();
            document.getElementById('oidc-enabled-toggle').checked = settings.enabled;
            document.getElementById('oidc-issuer').value = settings.issuer || '';
            document.getElementById('oidc-client-id').value = settings.clientId || '';
            document.getElementById('oidc-client-secret').value = settings.clientSecret || '';
            document.getElementById('oidc-provider-name').value = settings.providerName || '';
            document.getElementById('oidc-icon-url').value = settings.iconUrl || '';
            document.getElementById('oidc-disable-local').checked = settings.disableLocalLogin || false;
            document.getElementById('oidc-auto-create').checked = settings.autoCreateUsers !== false;
            document.getElementById('oidc-default-role').value = settings.defaultRole || 'user';

            // Update disable local login description with provider name
            const disableLocalDesc = document.getElementById('oidc-disable-local-desc');
            if (disableLocalDesc) {
                const providerName = settings.providerName || 'SSO';
                disableLocalDesc.textContent = `Only allow login via ${providerName}`;
            }

            // Show/hide config fields
            document.getElementById('oidc-config-fields').style.display = settings.enabled ? 'block' : 'none';

            // Show discovery status if issuer is configured
            if (settings.issuer && settings.discoveredAt) {
                showDiscoveryStatus('success', `Discovered from ${settings.issuer}`);
            }
        }
    } catch (error) {
        console.error('Failed to load OIDC settings:', error);
    }
}

async function toggleOIDCEnabled(enabled) {
    // Toggle just enables/disables - preserves all other settings on server
    try {
        const response = await fetch(`${API_URL}/api/auth/oidc/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });

        if (response.ok) {
            showToast(enabled ? 'SSO enabled' : 'SSO disabled');
            checkOIDCEnabled();
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to toggle OIDC', 'error');
            // Revert toggle on failure
            document.getElementById('oidc-enabled-toggle').checked = !enabled;
        }
    } catch (error) {
        console.error('Failed to toggle OIDC:', error);
        showToast('Failed to toggle OIDC', 'error');
        document.getElementById('oidc-enabled-toggle').checked = !enabled;
    }
}

async function saveOIDCSettings() {
    const settings = {
        enabled: document.getElementById('oidc-enabled-toggle').checked,
        issuer: document.getElementById('oidc-issuer').value.trim(),
        clientId: document.getElementById('oidc-client-id').value.trim(),
        clientSecret: document.getElementById('oidc-client-secret').value,
        providerName: document.getElementById('oidc-provider-name').value.trim(),
        iconUrl: document.getElementById('oidc-icon-url').value.trim(),
        disableLocalLogin: document.getElementById('oidc-disable-local').checked,
        autoCreateUsers: document.getElementById('oidc-auto-create').checked,
        defaultRole: document.getElementById('oidc-default-role').value
    };

    try {
        const response = await fetch(`${API_URL}/api/auth/oidc/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        if (response.ok) {
            showToast('OIDC settings saved');
            checkOIDCEnabled();
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save OIDC settings', 'error');
        }
    } catch (error) {
        console.error('Failed to save OIDC settings:', error);
        showToast('Failed to save OIDC settings', 'error');
    }
}

async function resetOIDCSettings(btn) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm Reset';
        return;
    }

    // Second click - actually reset
    btn.disabled = true;
    btn.textContent = 'Resetting...';
    try {
        const response = await fetch(`${API_URL}/api/auth/oidc/reset`, {
            method: 'POST'
        });
        if (response.ok) {
            showToast('OIDC settings reset');
            // Clear form
            document.getElementById('oidc-enabled-toggle').checked = false;
            document.getElementById('oidc-issuer').value = '';
            document.getElementById('oidc-client-id').value = '';
            document.getElementById('oidc-client-secret').value = '';
            document.getElementById('oidc-provider-name').value = '';
            document.getElementById('oidc-icon-url').value = '';
            document.getElementById('oidc-disable-local').checked = false;
            document.getElementById('oidc-auto-create').checked = true;
            document.getElementById('oidc-default-role').value = 'user';
            // Clear discovery status and endpoints, collapse config
            hideDiscoveredEndpoints();
            document.getElementById('oidc-config-fields').style.display = 'none';
            const status = document.getElementById('oidc-discovery-status');
            if (status) status.style.display = 'none';
            checkOIDCEnabled();
            loadUsers();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to reset OIDC', 'error');
        }
    } catch (error) {
        console.error('Failed to reset OIDC:', error);
        showToast('Failed to reset OIDC', 'error');
    }
    btn.disabled = false;
    btn.classList.remove('confirm-delete');
    btn.textContent = 'Reset OIDC';
}

function showDiscoveryStatus(type, message) {
    const status = document.getElementById('oidc-discovery-status');
    if (status) {
        status.style.display = 'block';
        status.className = `discovery-status ${type}`;
        status.textContent = message;
    }
}

async function discoverOIDCIssuer() {
    const issuer = document.getElementById('oidc-issuer').value.trim();
    if (!issuer) {
        showToast('Enter an issuer URL first', 'error');
        return;
    }

    showDiscoveryStatus('loading', 'Discovering...');

    try {
        const response = await fetch(`${API_URL}/api/auth/oidc/discover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ issuer })
        });

        if (response.ok) {
            const data = await response.json();
            showDiscoveryStatus('success', `Found: ${data.issuer_name || data.issuer}`);
            // Auto-populate provider name if not set
            const providerNameInput = document.getElementById('oidc-provider-name');
            if (providerNameInput && !providerNameInput.value && data.issuer_name) {
                providerNameInput.value = data.issuer_name;
            }
            // Display discovered endpoints
            displayDiscoveredEndpoints(data);
            showToast('Issuer discovered successfully');
        } else {
            const error = await response.json();
            showDiscoveryStatus('error', error.error || 'Discovery failed');
            hideDiscoveredEndpoints();
        }
    } catch (error) {
        console.error('Failed to discover issuer:', error);
        showDiscoveryStatus('error', 'Discovery failed - check the URL');
        hideDiscoveredEndpoints();
    }
}

function displayDiscoveredEndpoints(data) {
    const container = document.getElementById('oidc-discovered-endpoints');
    if (!container) return;

    container.style.display = 'block';
    document.getElementById('oidc-auth-endpoint').textContent = data.authorization_endpoint || '-';
    document.getElementById('oidc-token-endpoint').textContent = data.token_endpoint || '-';
    document.getElementById('oidc-userinfo-endpoint').textContent = data.userinfo_endpoint || '-';
    document.getElementById('oidc-jwks-endpoint').textContent = data.jwks_uri || '-';
    document.getElementById('oidc-logout-endpoint').textContent = data.end_session_endpoint || '-';
}

function hideDiscoveredEndpoints() {
    const container = document.getElementById('oidc-discovered-endpoints');
    if (container) {
        container.style.display = 'none';
    }
}

function copyCallbackUrl() {
    const el = document.getElementById('oidc-callback-url');
    if (el) {
        navigator.clipboard.writeText(el.textContent).then(() => {
            showToast('Callback URL copied');
        }).catch(() => {
            showToast('Failed to copy', 'error');
        });
    }
}

// Ravelry admin settings
function copyRavelryCallbackUrl() {
    const el = document.getElementById('ravelry-callback-url');
    if (el) {
        navigator.clipboard.writeText(el.textContent).then(() => {
            showToast('Callback URL copied');
        }).catch(() => {
            showToast('Failed to copy', 'error');
        });
    }
}

let ravelrySettingsInitialized = false;
function initRavelrySettings() {
    if (!ravelrySettingsInitialized) {
        const enabledToggle = document.getElementById('ravelry-enabled-toggle');
        if (enabledToggle) {
            enabledToggle.addEventListener('change', async () => {
                document.getElementById('ravelry-config-fields').style.display = enabledToggle.checked ? 'block' : 'none';
                // Auto-save enabled state and update nav
                const ravelryNavBtn = document.getElementById('ravelry-nav-btn');
                const ravelryAddBtn = document.getElementById('add-ravelry-url');
                if (!enabledToggle.checked) {
                    // Turning off - save immediately and hide nav
                    await saveRavelrySettings();
                    if (ravelryNavBtn) ravelryNavBtn.style.display = 'none';
                    if (ravelryAddBtn) ravelryAddBtn.style.display = 'none';
                } else {
                    if (ravelryNavBtn) ravelryNavBtn.style.display = '';
                }
            });
        }

        const saveBtn = document.getElementById('save-ravelry-settings-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveRavelrySettings);
        }

        const testBtn = document.getElementById('test-ravelry-btn');
        if (testBtn) {
            testBtn.addEventListener('click', testRavelryConnection);
        }

        ravelrySettingsInitialized = true;
    }

    loadRavelrySettings();
}

async function testRavelryConnection() {
    const btn = document.getElementById('test-ravelry-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Testing...';
    btn.disabled = true;

    try {
        const response = await fetch(`${API_URL}/api/ravelry/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: document.getElementById('ravelry-client-id').value.trim(),
                clientSecret: document.getElementById('ravelry-client-secret').value
            })
        });

        if (response.ok) {
            showToast('Ravelry credentials are valid!', 'success');
        } else {
            const data = await response.json();
            showToast(data.error || 'Invalid credentials', 'error');
        }
    } catch (error) {
        showToast('Failed to test connection', 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function loadRavelrySettings() {
    try {
        const response = await fetch(`${API_URL}/api/ravelry/settings`);
        if (!response.ok) return;
        const settings = await response.json();

        document.getElementById('ravelry-enabled-toggle').checked = settings.enabled;
        document.getElementById('ravelry-client-id').value = settings.clientId || '';
        document.getElementById('ravelry-client-secret').value = settings.clientSecret || '';
        document.getElementById('ravelry-config-fields').style.display = settings.enabled ? 'block' : 'none';

        // Set callback URL
        const callbackEl = document.getElementById('ravelry-callback-url');
        if (callbackEl) {
            callbackEl.textContent = `${window.location.origin}/api/ravelry/callback`;
        }
    } catch (error) {
        console.error('Failed to load Ravelry settings:', error);
    }
}

async function saveRavelrySettings() {
    const settings = {
        enabled: document.getElementById('ravelry-enabled-toggle').checked,
        clientId: document.getElementById('ravelry-client-id').value.trim(),
        clientSecret: document.getElementById('ravelry-client-secret').value
    };

    try {
        const response = await fetch(`${API_URL}/api/ravelry/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        if (response.ok) {
            showToast('Ravelry settings saved');
            loadRavelrySettings();
            // Update nav visibility
            const ravelryNavBtn = document.getElementById('ravelry-nav-btn');
            if (ravelryNavBtn) ravelryNavBtn.style.display = settings.enabled ? '' : 'none';
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save Ravelry settings', 'error');
        }
    } catch (error) {
        console.error('Failed to save Ravelry settings:', error);
        showToast('Failed to save Ravelry settings', 'error');
    }
}

let oidcSettingsInitialized = false;
function initOIDCSettings() {
    if (!oidcSettingsInitialized) {
        const enabledToggle = document.getElementById('oidc-enabled-toggle');
        if (enabledToggle) {
            enabledToggle.addEventListener('change', () => {
                document.getElementById('oidc-config-fields').style.display = enabledToggle.checked ? 'block' : 'none';
                toggleOIDCEnabled(enabledToggle.checked);
            });
        }

        const saveBtn = document.getElementById('save-oidc-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveOIDCSettings);
        }

        const discoverBtn = document.getElementById('oidc-discover-btn');
        if (discoverBtn) {
            discoverBtn.addEventListener('click', discoverOIDCIssuer);
        }

        const resetBtn = document.getElementById('reset-oidc-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => resetOIDCSettings(resetBtn));
        }

        oidcSettingsInitialized = true;
    }

    loadOIDCSettings();
}

// Check if OIDC is enabled and show/hide login button
async function checkOIDCEnabled() {
    try {
        const response = await fetch(`${API_URL}/api/auth/oidc/enabled`);
        const data = await response.json();
        const oidcSection = document.getElementById('oidc-login');
        const localLoginForm = document.getElementById('login-form');
        const oidcLoginBtn = document.getElementById('oidc-login-btn');

        if (oidcSection) {
            oidcSection.style.display = data.enabled ? 'block' : 'none';
        }

        // Update OIDC button with provider name and optional icon
        if (oidcLoginBtn && data.enabled) {
            const iconHtml = data.iconUrl ? `<img src="${data.iconUrl}" alt="" class="oidc-btn-icon">` : '';
            oidcLoginBtn.innerHTML = `${iconHtml}Login with ${data.providerName || 'SSO'}`;
        }

        // Hide local login form if OIDC is enabled and local login is disabled
        if (localLoginForm) {
            localLoginForm.style.display = (data.enabled && data.disableLocalLogin) ? 'none' : 'block';
        }
    } catch (error) {
        console.error('Failed to check OIDC status:', error);
    }
}

// Default categories management (admin)
let defaultCategories = [];

async function loadDefaultCategories() {
    try {
        const response = await fetch(`${API_URL}/api/admin/default-categories`);
        if (response.ok) {
            defaultCategories = await response.json();
            renderDefaultCategoriesList();
        }
    } catch (error) {
        console.error('Failed to load default categories:', error);
    }
}

function renderDefaultCategoriesList() {
    const list = document.getElementById('default-categories-list');
    if (!list) return;

    if (defaultCategories.length === 0) {
        list.innerHTML = '<p class="empty-state">No default categories configured</p>';
        return;
    }

    list.innerHTML = defaultCategories.map((category, index) => `
        <div class="category-item" data-category="${escapeHtml(category)}" data-index="${index}">
            <div class="category-info">
                <span class="category-name">${escapeHtml(category)}</span>
            </div>
            <div class="category-actions">
                <button class="btn btn-small btn-secondary" onclick="startDefaultCategoryEdit(this.closest('.category-item'))">Edit</button>
                <button class="btn btn-small btn-danger" onclick="deleteDefaultCategory('${escapeHtml(category)}')">Delete</button>
            </div>
        </div>
    `).join('');
}

async function addDefaultCategory() {
    const input = document.getElementById('new-default-category-input');
    const name = input.value.trim();

    if (!name) return;

    if (defaultCategories.includes(name)) {
        showToast('Category already exists', 'error');
        return;
    }

    defaultCategories.push(name);
    await saveDefaultCategories();
    input.value = '';
}

async function deleteDefaultCategory(name) {
    defaultCategories = defaultCategories.filter(c => c !== name);
    await saveDefaultCategories();
}

function startDefaultCategoryEdit(item) {
    const nameSpan = item.querySelector('.category-name');
    const oldName = item.dataset.category;

    if (nameSpan.isContentEditable) return;

    nameSpan.contentEditable = true;
    nameSpan.classList.add('editing');
    nameSpan.focus();

    const range = document.createRange();
    range.selectNodeContents(nameSpan);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const saveEdit = async () => {
        const newName = nameSpan.textContent.trim();
        nameSpan.contentEditable = false;
        nameSpan.classList.remove('editing');

        if (newName && newName !== oldName) {
            const index = defaultCategories.indexOf(oldName);
            if (index !== -1) {
                defaultCategories[index] = newName;
                await saveDefaultCategories();
            }
        } else {
            renderDefaultCategoriesList();
        }
    };

    nameSpan.addEventListener('blur', saveEdit, { once: true });
    nameSpan.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            nameSpan.blur();
        } else if (e.key === 'Escape') {
            nameSpan.textContent = oldName;
            nameSpan.blur();
        }
    });
}

async function saveDefaultCategories() {
    try {
        const response = await fetch(`${API_URL}/api/admin/default-categories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categories: defaultCategories })
        });

        if (response.ok) {
            const data = await response.json();
            defaultCategories = data.categories;
            renderDefaultCategoriesList();
            showToast('Default categories saved');
        } else {
            throw new Error('Failed to save');
        }
    } catch (error) {
        console.error('Error saving default categories:', error);
        showToast('Failed to save default categories', 'error');
        loadDefaultCategories(); // Reload to revert
    }
}

let defaultCategoriesInitialized = false;
function initDefaultCategories() {
    if (!defaultCategoriesInitialized) {
        const addBtn = document.getElementById('add-default-category-btn');
        const input = document.getElementById('new-default-category-input');

        if (addBtn) {
            addBtn.addEventListener('click', addDefaultCategory);
        }
        if (input) {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') addDefaultCategory();
            });
        }

        defaultCategoriesInitialized = true;
    }

    loadDefaultCategories();
}

// Toast notification system
function showToast(message, type = 'success', duration = 2000) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' toast-error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

let _undoTimer = null;
function undoableDelete(label, removeFn, apiDeleteFn, restoreFn) {
    // Cancel any pending undo delete
    if (_undoTimer) { clearTimeout(_undoTimer); _undoTimer = null; }

    // Immediately remove from UI
    removeFn();

    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast toast-undo';
    toast.innerHTML = `<span>${label}</span><button class="undo-btn">Undo</button>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    let undone = false;
    toast.querySelector('.undo-btn').addEventListener('click', () => {
        undone = true;
        clearTimeout(_undoTimer);
        _undoTimer = null;
        restoreFn();
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    });

    _undoTimer = setTimeout(() => {
        _undoTimer = null;
        if (!undone) apiDeleteFn();
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Parse pattern name from image filename (e.g., "hello-world-123456.jpg" -> "Hello World")
function parsePatternFromFilename(filename) {
    const match = filename.match(/^(.+)-\d+\.jpg$/);
    if (!match) return 'Unknown';
    return match[1]
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

// Convert pattern name to URL-friendly slug
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Find pattern by slug (returns first match)
function findPatternBySlug(slug) {
    return patterns.find(p => slugify(p.name) === slug) ||
           currentPatterns.find(p => slugify(p.name) === slug);
}

// Get pattern URL slug (with ID fallback for uniqueness)
function getPatternSlug(pattern) {
    const baseSlug = slugify(pattern.name);
    // Check if there are multiple patterns with the same slug
    const duplicates = patterns.filter(p => slugify(p.name) === baseSlug);
    if (duplicates.length > 1) {
        return `${baseSlug}-${pattern.id}`;
    }
    return baseSlug;
}

// State
let patterns = [];
let patternsLoaded = false;
let currentPatterns = [];
let projects = []; // All projects
let currentProjects = []; // Projects marked as current
let projectSearchQuery = '';
let projectSort = localStorage.getItem('projectSort') || 'date-desc';
let projectShowFilter = localStorage.getItem('projectShowFilter') || 'all';
let currentProjectId = null; // Currently viewing project
let currentProjectPatterns = []; // Patterns in currently viewing project
let projectReorderMode = false; // Reorder mode for project patterns
let yarns = []; // Yarn inventory
let hooks = []; // Hook inventory
let inventoryView = localStorage.getItem('inventoryView') || 'card';
let inventorySubTab = localStorage.getItem('inventorySubTab') || 'yarn';
let libraryView = localStorage.getItem('libraryView') || 'card';
let patternListSort = { col: 'name', dir: 'asc' };
let libraryEditMode = false;
let yarnSort = JSON.parse(localStorage.getItem('yarnSort') || '{"col":"brand","dir":"asc"}');
let hookSort = JSON.parse(localStorage.getItem('hookSort') || '{"col":"brand","dir":"asc"}');
let editingYarnId = null;
let editingHookId = null;
let selectedYarnIds = new Set();
let selectedHookIds = new Set();
let allCategories = []; // All possible categories for editing/uploading
let populatedCategories = []; // Only categories with patterns (for filtering)
let allHashtags = []; // All available hashtags
let selectedFile = null;
let editingPatternId = null;
let stagedFiles = []; // Array to hold staged files with metadata
let projectStagedFiles = []; // Array to hold staged files for project creation
let projectSelectedPatternIds = []; // IDs of existing patterns to add to new project
let addModalStagedFiles = []; // Array to hold staged files for add patterns modal
let completedUploads = []; // Array to hold completed upload info for display
let selectedCategoryFilter = localStorage.getItem('libraryCategoryFilter') || 'all';
let selectedSort = localStorage.getItem('librarySort') || 'date-desc';
let showCompleted = localStorage.getItem('libraryShowCompleted') !== 'false';
let showCurrent = localStorage.getItem('libraryShowCurrent') !== 'false';
let showPdf = localStorage.getItem('libraryShowPdf') !== 'false';
let showMarkdown = localStorage.getItem('libraryShowMarkdown') !== 'false';
let highlightMode = localStorage.getItem('libraryHighlightMode') || 'none';
let pinCurrent = localStorage.getItem('libraryPinCurrent') === 'true';
let pinFavorites = localStorage.getItem('libraryPinFavorites') === 'true';
let showFilter = localStorage.getItem('libraryShowFilter') || 'all';
let ratingFilter = localStorage.getItem('libraryRatingFilter') || 'all';
let ownerFilter = localStorage.getItem('libraryOwnerFilter') || 'all';
let searchQuery = '';
let previousTab = 'current';
let navigationHistory = []; // Stack for UI back button
let isNavigatingBack = false; // Flag to prevent double history push
let showTabCounts = localStorage.getItem('showTabCounts') !== 'false';
let showTypeBadge = localStorage.getItem('showTypeBadge') !== 'false';
let showStatusBadge = localStorage.getItem('showStatusBadge') !== 'false';
let showCategoryBadge = localStorage.getItem('showCategoryBadge') !== 'false';
let showStarBadge = localStorage.getItem('showStarBadge') !== 'false';
let showRatingBadge = localStorage.getItem('showRatingBadge') !== 'false';
let autoCurrentOnTimer = localStorage.getItem('autoCurrentOnTimer') === 'true';
let autoTimerDefault = localStorage.getItem('autoTimerDefault') === 'true';
let autoTimerEnabled = false;
let autoTimerPausedInactive = false;
let inactivityTimeout = null;
let inactivityDelay = parseInt(localStorage.getItem('inactivityTimeout') || '5', 10) * 60 * 1000;
let defaultCategory = localStorage.getItem('defaultCategory') || 'Amigurumi';
let enableDirectDelete = localStorage.getItem('enableDirectDelete') === 'true';
let showInventoryTab = localStorage.getItem('showInventoryTab') !== 'false';

// Bulk selection state
let selectedPatternIds = new Set();

function getDefaultCategory() {
    // Return the stored default, but fallback to first category if default doesn't exist
    if (allCategories.includes(defaultCategory)) {
        return defaultCategory;
    }
    return allCategories[0] || 'Amigurumi';
}

function setDefaultCategory(category) {
    defaultCategory = category;
    localStorage.setItem('defaultCategory', category);
    renderCategoriesList();
    showToast('Default category updated');
}

// PDF Viewer State
let pdfDoc = null;
let currentPageNum = 1;
let totalPages = 0;
let currentPattern = null;
const pdfCacheVersions = {}; // patternId → timestamp for cache busting after annotation changes
const pendingAnnotationSaves = {}; // patternId → Promise for in-flight annotation PUT
let counters = [];
let lastUsedCounterId = null;
let pdfZoomScale = 1.0; // Current zoom scale for manual zoom
let pdfZoomMode = 'fit'; // 'fit' = fit page, 'fit-width' = fit width, 'manual' = use pdfZoomScale
let pdfFitScale = 1.0; // The calculated scale that fits the page in view
let pdfFitWidthScale = 1.0; // The calculated scale that fits the width

// Timer State
let timerRunning = false;
let timerSeconds = 0;
let timerInterval = null;
let timerSaveTimeout = null;
let timerResetConfirming = false;
let timerResetTimeout = null;

// Keyboard Shortcuts
const defaultShortcuts = {
    counterIncrease: ['ArrowUp', '', ''],
    counterDecrease: ['ArrowDown', '', ''],
    prevPage: ['ArrowLeft', '', ''],
    nextPage: ['ArrowRight', '', ''],
    toggleTimer: [' ', '', ''], // Space
    nextCounter: ['Tab', '', ''],
    zoomIn: ['=', '+', ''], // = is unshifted + on most keyboards
    zoomOut: ['-', '', ''],
    exitViewer: ['Escape', '', '']
};
// Merge saved shortcuts with defaults (so new shortcuts get added)
let keyboardShortcuts = (() => {
    const saved = JSON.parse(localStorage.getItem('keyboardShortcuts')) || {};
    const merged = JSON.parse(JSON.stringify(defaultShortcuts));
    // Override defaults with any saved values
    for (const key in saved) {
        if (key in merged) {
            merged[key] = saved[key];
        }
    }
    return merged;
})();

// Timer Functions
function initTimer() {
    // PDF timer button
    const pdfTimerBtn = document.getElementById('pdf-timer-btn');
    if (pdfTimerBtn) {
        pdfTimerBtn.addEventListener('click', toggleTimer);
    }

    // Markdown timer button
    const markdownTimerBtn = document.getElementById('markdown-timer-btn');
    if (markdownTimerBtn) {
        markdownTimerBtn.addEventListener('click', toggleTimer);
    }

    // PDF timer reset button
    const pdfResetBtn = document.getElementById('pdf-timer-reset-btn');
    if (pdfResetBtn) {
        pdfResetBtn.addEventListener('click', handleTimerReset);
    }

    // Markdown timer reset button
    const markdownResetBtn = document.getElementById('markdown-timer-reset-btn');
    if (markdownResetBtn) {
        markdownResetBtn.addEventListener('click', handleTimerReset);
    }

    // Auto timer checkboxes
    const pdfAutoTimerCheckbox = document.getElementById('pdf-auto-timer-checkbox');
    const markdownAutoTimerCheckbox = document.getElementById('markdown-auto-timer-checkbox');

    if (pdfAutoTimerCheckbox) {
        pdfAutoTimerCheckbox.addEventListener('change', toggleAutoTimer);
    }
    if (markdownAutoTimerCheckbox) {
        markdownAutoTimerCheckbox.addEventListener('change', toggleAutoTimer);
    }

    // Inactivity detection for auto timer
    const resetInactivity = () => {
        if (autoTimerEnabled) {
            // If we were paused due to inactivity, resume
            if (autoTimerPausedInactive) {
                autoTimerPausedInactive = false;
                updateAutoTimerButtonState();
                if (!timerRunning) {
                    startTimer();
                }
            }
            // Reset the timeout
            if (inactivityTimeout) {
                clearTimeout(inactivityTimeout);
            }
            if (inactivityDelay > 0) {
                inactivityTimeout = setTimeout(() => {
                    if (autoTimerEnabled && timerRunning) {
                        autoTimerPausedInactive = true;
                        stopTimer();
                        updateAutoTimerButtonState();
                    }
                }, inactivityDelay);
            }
        }
    };

    // Listen for user activity
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(event => {
        document.addEventListener(event, resetInactivity, { passive: true });
    });

    // Save timer when page is hidden, resume when returning
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && timerRunning) {
            stopTimer(true);
        } else if (!document.hidden && autoTimerEnabled && !timerRunning) {
            startTimer();
            resetInactivity();
        }
    });

    // Save current page position when page is hidden (survives OS process kill)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && currentPattern && currentPageNum) {
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/page`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPage: currentPageNum }),
                keepalive: true
            }).catch(() => {});
            if (typeof savePdfViewerState === 'function') {
                savePdfViewerState();
            }
        }
    });
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateTimerDisplay() {
    const pdfDisplay = document.getElementById('pdf-timer-display');
    const markdownDisplay = document.getElementById('markdown-timer-display');
    const mobileDisplay = document.getElementById('mobile-timer-display');
    const mdMobileDisplay = document.getElementById('md-mobile-timer-display');
    const timeString = formatTime(timerSeconds);

    if (pdfDisplay) pdfDisplay.textContent = timeString;
    if (markdownDisplay) markdownDisplay.textContent = timeString;
    if (mobileDisplay) mobileDisplay.textContent = timeString;
    if (mdMobileDisplay) mdMobileDisplay.textContent = timeString;
}

function updateTimerButtonState() {
    const pdfBtn = document.getElementById('pdf-timer-btn');
    const markdownBtn = document.getElementById('markdown-timer-btn');
    const mobileBtn = document.getElementById('mobile-timer-btn');
    const mdMobileBtn = document.getElementById('md-mobile-timer-btn');

    if (timerRunning) {
        if (pdfBtn) pdfBtn.classList.add('timer-running');
        if (markdownBtn) markdownBtn.classList.add('timer-running');
        if (mobileBtn) mobileBtn.classList.add('timer-running');
        if (mdMobileBtn) mdMobileBtn.classList.add('timer-running');
    } else {
        if (pdfBtn) pdfBtn.classList.remove('timer-running');
        if (markdownBtn) markdownBtn.classList.remove('timer-running');
        if (mobileBtn) mobileBtn.classList.remove('timer-running');
        if (mdMobileBtn) mdMobileBtn.classList.remove('timer-running');
    }
}

function toggleTimer() {
    if (timerRunning) {
        stopTimer();
    } else {
        startTimer();
    }
}

function toggleAutoTimer(e) {
    // If called from checkbox change event, use checkbox state; otherwise toggle
    if (e && e.target && e.target.type === 'checkbox') {
        autoTimerEnabled = e.target.checked;
        // Sync all other auto-timer checkboxes
        const allIds = ['pdf-auto-timer-checkbox', 'markdown-auto-timer-checkbox', 'mobile-auto-timer-checkbox', 'md-mobile-auto-timer-checkbox'];
        allIds.forEach(id => {
            if (id !== e.target.id) {
                const cb = document.getElementById(id);
                if (cb) cb.checked = autoTimerEnabled;
            }
        });
    } else {
        autoTimerEnabled = !autoTimerEnabled;
    }
    autoTimerPausedInactive = false;
    if (currentPattern) {
        sessionStorage.setItem(`autoTimer_${currentPattern.id}`, autoTimerEnabled);
    }
    updateAutoTimerButtonState();

    if (autoTimerEnabled) {
        // Start timer immediately when auto timer is enabled
        if (!timerRunning) {
            startTimer();
        }
        // Start inactivity tracking
        if (inactivityTimeout) {
            clearTimeout(inactivityTimeout);
        }
        if (inactivityDelay > 0) {
            inactivityTimeout = setTimeout(() => {
                if (autoTimerEnabled && timerRunning) {
                    autoTimerPausedInactive = true;
                    stopTimer();
                    updateAutoTimerButtonState();
                }
            }, inactivityDelay);
        }
    } else {
        // Stop inactivity tracking
        if (inactivityTimeout) {
            clearTimeout(inactivityTimeout);
            inactivityTimeout = null;
        }
    }
}

function updateAutoTimerButtonState() {
    const pdfCheckbox = document.getElementById('pdf-auto-timer-checkbox');
    const markdownCheckbox = document.getElementById('markdown-auto-timer-checkbox');
    const mobileCheckbox = document.getElementById('mobile-auto-timer-checkbox');
    const mdMobileCheckbox = document.getElementById('md-mobile-auto-timer-checkbox');
    const pdfToggle = pdfCheckbox?.closest('.auto-timer-toggle');
    const markdownToggle = markdownCheckbox?.closest('.auto-timer-toggle');
    const mobileToggle = mobileCheckbox?.closest('.mobile-menu-toggle');
    const mdMobileToggle = mdMobileCheckbox?.closest('.mobile-menu-toggle');

    [pdfCheckbox, markdownCheckbox, mobileCheckbox, mdMobileCheckbox].forEach(checkbox => {
        if (!checkbox) return;
        checkbox.checked = autoTimerEnabled;
    });

    [pdfToggle, markdownToggle, mobileToggle, mdMobileToggle].forEach(toggle => {
        if (!toggle) return;
        toggle.classList.remove('paused-inactive');
        if (autoTimerPausedInactive) {
            toggle.classList.add('paused-inactive');
            toggle.title = 'Auto timer paused (inactive) - move to resume';
        } else if (autoTimerEnabled) {
            toggle.title = 'Auto timer enabled - click to disable';
        } else {
            toggle.title = 'Auto timer: runs while viewing, pauses on inactivity';
        }
    });
}

function startTimer() {
    if (timerRunning || !currentPattern) return;

    timerRunning = true;
    updateTimerButtonState();

    // Auto-mark as current if setting is enabled and pattern isn't already current
    if (autoCurrentOnTimer && !currentPattern.is_current) {
        toggleCurrent(currentPattern.id, true);
    }

    timerInterval = setInterval(() => {
        timerSeconds++;
        updateTimerDisplay();

        // Auto-save every 30 seconds
        if (timerSeconds % 30 === 0) {
            saveTimer();
        }
    }, 1000);
}

function stopTimer(sync = false) {
    if (!timerRunning) return;

    timerRunning = false;
    updateTimerButtonState();

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    // Stash in sessionStorage so reloads don't lose seconds to server lag
    if (currentPattern) {
        sessionStorage.setItem(`timerSeconds_${currentPattern.id}`, timerSeconds);
    }

    // Save timer to database
    if (sync) {
        // Synchronous save for beforeunload
        if (currentPattern && navigator.sendBeacon) {
            const data = JSON.stringify({ timer_seconds: timerSeconds });
            navigator.sendBeacon(`${API_URL}/api/patterns/${currentPattern.id}/timer`, data);
        }
    } else {
        saveTimer();
    }
}

async function saveTimer() {
    if (!currentPattern) return;

    // Debounce saves
    if (timerSaveTimeout) {
        clearTimeout(timerSaveTimeout);
    }

    timerSaveTimeout = setTimeout(async () => {
        try {
            await fetch(`${API_URL}/api/patterns/${currentPattern.id}/timer`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timer_seconds: timerSeconds })
            });
            sessionStorage.removeItem(`timerSeconds_${currentPattern.id}`);
        } catch (error) {
            console.error('Error saving timer:', error);
        }
    }, 500);
}

async function saveTimerImmediate() {
    if (!currentPattern) return;

    // Cancel any pending debounced save
    if (timerSaveTimeout) {
        clearTimeout(timerSaveTimeout);
        timerSaveTimeout = null;
    }

    console.log('saveTimerImmediate called, timerSeconds:', timerSeconds, 'pattern:', currentPattern.id);

    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/timer`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timer_seconds: timerSeconds })
        });
        console.log('Timer save response:', response.status);
    } catch (error) {
        console.error('Error saving timer:', error);
    }
}

function resetTimerState() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    if (timerSaveTimeout) {
        clearTimeout(timerSaveTimeout);
        timerSaveTimeout = null;
    }
    timerRunning = false;
    timerSeconds = 0;
    updateTimerDisplay();
    updateTimerButtonState();
    cancelTimerResetConfirmation();
}

function handleTimerReset() {
    if (!currentPattern) return;

    if (timerResetConfirming) {
        // Second click - perform the reset
        cancelTimerResetConfirmation();

        // Stop timer if running
        if (timerRunning) {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            timerRunning = false;
        }

        // Reset to zero
        timerSeconds = 0;
        updateTimerDisplay();
        updateTimerButtonState();

        // Save to database
        saveTimer();
    } else {
        // First click - enter confirmation mode
        timerResetConfirming = true;
        updateResetButtonState();

        // Auto-cancel after 3 seconds
        timerResetTimeout = setTimeout(() => {
            cancelTimerResetConfirmation();
        }, 3000);
    }
}

function cancelTimerResetConfirmation() {
    timerResetConfirming = false;
    if (timerResetTimeout) {
        clearTimeout(timerResetTimeout);
        timerResetTimeout = null;
    }
    updateResetButtonState();
}

function updateResetButtonState() {
    const pdfResetBtn = document.getElementById('pdf-timer-reset-btn');
    const markdownResetBtn = document.getElementById('markdown-timer-reset-btn');
    const mobileResetBtn = document.getElementById('mobile-timer-reset-btn');
    const mdMobileResetBtn = document.getElementById('md-mobile-timer-reset-btn');

    if (timerResetConfirming) {
        if (pdfResetBtn) pdfResetBtn.classList.add('confirming');
        if (markdownResetBtn) markdownResetBtn.classList.add('confirming');
        [mobileResetBtn, mdMobileResetBtn].forEach(btn => {
            if (btn) {
                btn.classList.add('confirming');
                btn.textContent = 'Confirm Reset?';
            }
        });
    } else {
        if (pdfResetBtn) pdfResetBtn.classList.remove('confirming');
        if (markdownResetBtn) markdownResetBtn.classList.remove('confirming');
        [mobileResetBtn, mdMobileResetBtn].forEach(btn => {
            if (btn) {
                btn.classList.remove('confirming');
                btn.textContent = 'Reset Timer';
            }
        });
    }
}

function loadPatternTimer(pattern) {
    const sessionSeconds = sessionStorage.getItem(`timerSeconds_${pattern.id}`);
    timerSeconds = sessionSeconds !== null ? parseInt(sessionSeconds, 10) : (pattern.timer_seconds || 0);
    timerRunning = false;
    updateTimerDisplay();
    updateTimerButtonState();
}

// PDF.js configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const pdfViewerContainer = document.getElementById('pdf-viewer-container');
const pdfCanvas = document.getElementById('pdf-canvas');

function initAppUI() {
    // Global haptic feedback for buttons and toggles on mobile
    let hapticStartX = 0, hapticStartY = 0;
    document.addEventListener('touchstart', (e) => {
        hapticStartX = e.touches[0].clientX;
        hapticStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
        if (!navigator.vibrate || localStorage.getItem('hapticFeedback') === 'false') return;
        const dx = e.changedTouches[0].clientX - hapticStartX;
        const dy = e.changedTouches[0].clientY - hapticStartY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
        const interactive = e.target.closest('button, .toggle-switch, .tab-btn, .settings-nav-btn, .mobile-bar-btn, .mobile-bar-nav, .day-night-toggle .mode-btn');
        if (interactive) navigator.vibrate(200);
    }, { passive: true });

    initTabs();
    if (localStorage.getItem('hasProjects') === 'true') {
        const projectsTabBtn = document.getElementById('projects-tab-btn');
        if (projectsTabBtn) projectsTabBtn.style.display = 'block';
    }
    initSwipeNavigation();
    initUpload();
    initEditModal();
    initPDFViewer();
    initLibraryFilters();
    initSettings();
    initAddMenu();
    initNewPatternPanel();
    initThumbnailSelector();
    initTimer();
    initBackups();
    initNavigation();
    initGlobalDragDrop();
    initServerEvents();
    initHorizontalScroll();
    initUserManagement();
    initInventory();
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize auth and login form
    initAuth();
    initTheme();

    // Enable body transitions only AFTER first paint
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.body.classList.add('theme-ready');
        });
    });

    // Show app container immediately if previously authenticated (skip login flash)
    const wasAuthenticated = localStorage.getItem('authenticated') === 'true';
    if (wasAuthenticated) {
        document.getElementById('login-container').style.display = 'none';
        document.querySelector('.container').style.display = 'block';
        // Apply cached permissions immediately to prevent button flash
        if (localStorage.getItem('canUploadPdf') === 'false') {
            const uploadPdf = document.getElementById('add-upload-pdf');
            if (uploadPdf) uploadPdf.style.display = 'none';
        }
        if (localStorage.getItem('canCreateMarkdown') === 'false') {
            const newPattern = document.getElementById('add-new-pattern');
            if (newPattern) newPattern.style.display = 'none';
        }
    }

    // Verify auth
    const isAuthenticated = await checkAuth();
    if (!isAuthenticated) {
        localStorage.removeItem('authenticated');
        showLogin();
        return;
    }
    localStorage.setItem('authenticated', 'true');
    await loadServerSettings();
    if (!wasAuthenticated) showApp();
    updateUIForUser();

    initAppUI();
    applyInventoryTabVisibility();
    appInitialized = true;
    checkForNewVersion();
    await Promise.all([loadPatterns(), loadProjects(), loadYarns(), loadHooks()]);
    loadCurrentPatterns();
    loadCategories();
    loadHashtags();
    await loadCurrentProjects();
    updateTabCounts();
    displayCurrentPatterns();
    initProjectPanel();
    initProjectSidebar();
    await handleInitialNavigation();
});

// Enable horizontal scrolling with mouse wheel for hashtag selectors
let horizontalScrollInitialized = false;
function initHorizontalScroll() {
    if (horizontalScrollInitialized) return;
    horizontalScrollInitialized = true;

    document.addEventListener('wheel', (e) => {
        const selector = e.target.closest('.hashtag-selector');
        if (!selector || e.ctrlKey || e.shiftKey) return;

        // Only handle if there's horizontal overflow
        if (selector.scrollWidth <= selector.clientWidth) return;

        // Detect mouse wheel vs trackpad: mouse wheels typically have larger, discrete deltas
        // Trackpads have small, frequent deltas. Only intercept likely mouse wheel events.
        const isLikelyMouseWheel = Math.abs(e.deltaY) >= 50 || e.deltaMode === 1;

        if (isLikelyMouseWheel) {
            e.preventDefault();
            selector.scrollLeft += e.deltaY;
        }
    }, { passive: false });
}

// Server-sent events for real-time notifications
// Manage SSE connection based on page visibility
function initServerEvents() {
    let eventSource = null;
    let connectTimeout = null;

    function connect() {
        if (eventSource || document.hidden) return;
        eventSource = new EventSource(`${API_URL}/api/events`);
        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleServerEvent(data);
            } catch (error) {
                console.error('Error parsing server event:', error);
            }
        };
        eventSource.onerror = () => {
            // Close on error to prevent auto-reconnect when hidden
            if (document.hidden) disconnect();
        };
    }

    function disconnect() {
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        if (eventSource) {
            eventSource.onmessage = null;
            eventSource.onerror = null;
            eventSource.close();
            eventSource = null;
        }
    }

    // Delay initial connect so page lifecycle can settle
    connectTimeout = setTimeout(connect, 1000);

    // Close on hide, reconnect on show
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            disconnect();
        } else {
            // Small delay on reconnect to avoid racing with page resume
            connectTimeout = setTimeout(connect, 500);
        }
    });

    // Last-chance cleanup before page is frozen/discarded
    window.addEventListener('pagehide', disconnect);
}

function handleServerEvent(event) {
    switch (event.type) {
        case 'backup_complete':
            showToast('Scheduled backup complete', 'success', 4000);
            // Refresh backups list if on settings page
            if (document.getElementById('settings')?.classList.contains('active')) {
                loadBackups();
            }
            break;
        case 'backup_error':
            showToast(`Backup failed: ${event.data.error}`, 'error', 5000);
            break;
        case 'ravelry-import-progress': {
            console.log('Ravelry SSE progress:', event.data);
            const rpt = document.getElementById('ravelry-progress-text');
            const rpb = document.getElementById('ravelry-progress-bar');
            if (rpt) rpt.textContent = event.data.status;
            if (rpb && event.data.total > 0) {
                const pct = Math.round((event.data.current / event.data.total) * 100);
                rpb.style.width = Math.max(pct, 5) + '%';
            }
            break;
        }
        case 'ravelry-import-complete':
            console.log('Ravelry SSE complete:', event.data);
            showToast('Ravelry import complete!', 'success');
            handleRavelryImportComplete(event.data);
            break;
        case 'ravelry-import-error': {
            console.log('Ravelry SSE error:', event.data);
            const rpet = document.getElementById('ravelry-progress-text');
            if (rpet) rpet.textContent = `Import error: ${event.data.error}`;
            ravelryState.importing = false;
            const rImportSelBtn = document.getElementById('ravelry-import-selected-btn');
            const rImportAllBtn = document.getElementById('ravelry-import-all-btn');
            if (rImportSelBtn) rImportSelBtn.disabled = false;
            if (rImportAllBtn) rImportAllBtn.disabled = false;
            showToast(event.data.error || 'Ravelry import failed', 'error', 6000);
            break;
        }
        default:
            console.log('Unknown server event:', event);
    }
}

// Navigation initialization
function initNavigation() {
    // Handle browser back/forward buttons
    window.addEventListener('popstate', async (e) => {
        isNavigatingBack = true;
        if (e.state && e.state.view) {
            await navigateToView(e.state.view, false);
        } else {
            // No state, check hash
            const hash = window.location.hash.slice(1);
            if (hash) {
                await navigateToView(hash, false);
            } else {
                switchToTab('current', false);
            }
        }
        isNavigatingBack = false;
    });
}

// Global drag-drop to open upload panel
function initGlobalDragDrop() {
    const handleDrop = (e) => {
        // Only handle external file drops, not internal column drags
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.remove('global-drag-over');

        // Don't handle if dropping on project drop zone or new project panel is visible
        const newProjectPanel = document.getElementById('new-project-panel');
        const projectDropZone = document.getElementById('project-drop-zone');
        if (newProjectPanel && newProjectPanel.style.display !== 'none') {
            // Let the project drop zone handle it
            return;
        }

        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        if (files.length > 0) {
            showUploadPanel();
            handleFiles(files);
        }
    };

    const handleDragOver = (e) => {
        // Only handle external file drags, not internal column drags
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        // Don't show overlay if upload panel is already visible or new project panel is visible
        const uploadPanel = document.getElementById('upload-panel');
        const newProjectPanel = document.getElementById('new-project-panel');
        if (newProjectPanel && newProjectPanel.style.display !== 'none') {
            return;
        }
        if (!uploadPanel || uploadPanel.style.display === 'none') {
            document.body.classList.add('global-drag-over');
        }
    };

    const handleDragLeave = (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.relatedTarget === null || !document.body.contains(e.relatedTarget)) {
            document.body.classList.remove('global-drag-over');
        }
    };

    // Add to document to catch all drag-drop events
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);
}

async function handleInitialNavigation() {
    const hash = window.location.hash.slice(1);

    // URL hash takes priority (for cmd+click opening new tab)
    if (hash) {
        if (hash.startsWith('pattern/')) {
            const slug = hash.split('/')[1];
            // Try to find pattern by slug first, then by ID for backwards compatibility
            let pattern = findPatternBySlug(slug);
            if (!pattern && !isNaN(parseInt(slug))) {
                pattern = patterns.find(p => p.id === parseInt(slug));
            }
            // Handle slug-with-id format (e.g., "my-pattern-42" for duplicate slugs)
            if (!pattern) {
                const match = slug.match(/^(.+)-(\d+)$/);
                if (match) {
                    const id = parseInt(match[2]);
                    pattern = patterns.find(p => p.id === id) || currentPatterns.find(p => p.id === id);
                }
            }
            if (pattern) {
                await openPDFViewer(pattern.id, false);
            } else {
                // Pattern not found — fall back to default page
                const defaultPage = localStorage.getItem('defaultPage') || 'current';
                switchToTab(defaultPage, false);
                history.replaceState({ view: defaultPage }, '', `#${defaultPage}`);
                return;
            }
        } else if (hash.startsWith('settings/')) {
            const section = hash.split('/')[1];
            switchToTab('settings', false);
            switchToSettingsSection(section, false);
        } else if (hash === 'settings') {
            switchToTab('settings', false);
        } else if (['current', 'library'].includes(hash)) {
            switchToTab(hash, false);
        }
        history.replaceState({ view: hash }, '', `#${hash}`);
        return;
    }

    // Default: go to default page
    const defaultPage = localStorage.getItem('defaultPage') || 'current';
    history.replaceState({ view: defaultPage }, '', `#${defaultPage}`);
}

// Setup image paste handler for markdown textareas
// getPatternName is a function that returns the current pattern name for the context
function setupImagePaste(textarea, getPatternName) {
    async function insertImage(file) {
        // Show uploading indicator
        const cursorPos = textarea.selectionStart;
        const placeholder = '![Uploading image...]()';
        const before = textarea.value.substring(0, cursorPos);
        const after = textarea.value.substring(textarea.selectionEnd);
        textarea.value = before + placeholder + after;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        try {
            // Upload the image with pattern name for organization
            const formData = new FormData();
            formData.append('image', file);
            formData.append('patternName', getPatternName ? getPatternName() : 'image');

            const response = await fetch(`${API_URL}/api/images`, {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                const data = await response.json();
                // Replace placeholder with actual image markdown
                const imageMarkdown = `![image](${data.url})`;
                textarea.value = textarea.value.replace(placeholder, imageMarkdown);
                textarea.selectionStart = textarea.selectionEnd = cursorPos + imageMarkdown.length;
            } else {
                // Remove placeholder on error
                textarea.value = textarea.value.replace(placeholder, '');
            }
        } catch (error) {
            console.error('Error uploading image:', error);
            textarea.value = textarea.value.replace(placeholder, '');
        }

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Paste support
    textarea.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) insertImage(file);
                return;
            }
        }
    });

    // Drag-and-drop support
    textarea.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            textarea.classList.add('image-drag-over');
        }
    });

    textarea.addEventListener('dragleave', () => {
        textarea.classList.remove('image-drag-over');
    });

    textarea.addEventListener('drop', async (e) => {
        textarea.classList.remove('image-drag-over');
        const files = e.dataTransfer?.files;
        if (!files) return;

        for (const file of files) {
            if (file.type.startsWith('image/')) {
                e.preventDefault();
                e.stopPropagation();
                insertImage(file);
                return;
            }
        }
    });
}

// Auto-continue lists in markdown editors (bullets, numbers, checkboxes)
function setupMarkdownListContinuation(textarea) {
    textarea.addEventListener('keydown', (e) => {
        // Tab/Shift+Tab to indent/outdent list items
        if (e.key === 'Tab') {
            const { selectionStart, selectionEnd, value } = textarea;
            const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
            const lineEnd = value.indexOf('\n', selectionEnd);
            const lineEndPos = lineEnd === -1 ? value.length : lineEnd;
            const selectedLines = value.substring(lineStart, lineEndPos);

            // Only handle Tab on list lines (bullets, numbers, checkboxes)
            if (!/^\s*([-*+]|\d+\.)\s/.test(selectedLines)) return;

            e.preventDefault();
            const lines = selectedLines.split('\n');
            const modified = lines.map(line => {
                if (e.shiftKey) {
                    // Outdent: remove up to 2 leading spaces
                    return line.replace(/^ {1,2}/, '');
                } else {
                    // Indent: add 2 spaces
                    return '  ' + line;
                }
            });
            const result = modified.join('\n');
            textarea.value = value.substring(0, lineStart) + result + value.substring(lineEndPos);
            textarea.selectionStart = lineStart;
            textarea.selectionEnd = lineStart + result.length;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        if (e.key !== 'Enter') return;

        const { selectionStart, value } = textarea;
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const currentLine = value.substring(lineStart, selectionStart);

        // Match bullet points (-, *, +), numbered lists (1. 2. etc), or checkboxes (- [ ] or - [x])
        const bulletMatch = currentLine.match(/^(\s*)([-*+])\s+(\[[ x]\]\s+)?/);
        const numberMatch = currentLine.match(/^(\s*)(\d+)\.\s+/);

        let prefix = '';

        if (bulletMatch) {
            const [fullMatch, indent, bullet, checkbox] = bulletMatch;
            // If line only has the bullet (empty item), remove it instead of continuing
            if (currentLine.trim() === bullet || currentLine.trim() === `${bullet} [ ]` || currentLine.trim() === `${bullet} [x]`) {
                e.preventDefault();
                // Remove the empty bullet line
                textarea.value = value.substring(0, lineStart) + value.substring(selectionStart);
                textarea.selectionStart = textarea.selectionEnd = lineStart;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            prefix = indent + bullet + ' ' + (checkbox ? '[ ] ' : '');
        } else if (numberMatch) {
            const [fullMatch, indent, num] = numberMatch;
            // If line only has the number (empty item), remove it instead of continuing
            if (currentLine.trim() === `${num}.`) {
                e.preventDefault();
                textarea.value = value.substring(0, lineStart) + value.substring(selectionStart);
                textarea.selectionStart = textarea.selectionEnd = lineStart;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            prefix = indent + (parseInt(num) + 1) + '. ';
        }

        if (prefix) {
            e.preventDefault();
            const before = value.substring(0, selectionStart);
            const after = value.substring(selectionStart);
            textarea.value = before + '\n' + prefix + after;
            textarea.selectionStart = textarea.selectionEnd = selectionStart + 1 + prefix.length;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

// Font loading
function applyFont(fontName, customFontName = null) {
    const fontToLoad = customFontName || fontName;

    // Remove existing custom font link and style overrides
    const existingLink = document.getElementById('custom-google-font');
    if (existingLink) existingLink.remove();
    const existingStyle = document.getElementById('custom-font-style');
    if (existingStyle) existingStyle.remove();

    // JetBrains Mono is bundled locally, no need to fetch from Google
    if (fontToLoad !== 'JetBrains Mono') {
        const encodedFont = fontToLoad.replace(/ /g, '+');
        const link = document.createElement('link');
        link.id = 'custom-google-font';
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodedFont}&display=swap`;
        document.head.appendChild(link);

        // Check if font actually loaded after a delay
        if (customFontName && document.fonts) {
            setTimeout(() => {
                if (!document.fonts.check(`16px "${fontToLoad}"`)) {
                    showToast(`Font "${fontToLoad}" not found. Use the exact name from Google Fonts' CSS embed code.`, 'error');
                }
            }, 3000);
        }
    }

    // Apply font via injected style to ensure it overrides everything
    const style = document.createElement('style');
    style.id = 'custom-font-style';
    style.textContent = `:root { --font-family: "${fontToLoad}", sans-serif !important; }`;
    document.head.appendChild(style);
}

// Theme data for picker modal
const THEME_DATA = {
    standard: [
        { id: 'lavender', name: 'Lavender', primary: '#a78bfa', secondary: '#f472b6' },
        { id: 'ocean', name: 'Ocean', primary: '#38bdf8', secondary: '#22d3ee' },
        // { id: 'forest', name: 'Forest', primary: '#4ade80', secondary: '#a3e635' },
        { id: 'rose', name: 'Rose', primary: '#fb7185', secondary: '#db2777' },
        { id: 'slate', name: 'Slate', primary: '#818cf8', secondary: '#94a3b8' },
        { id: 'aqua', name: 'Aqua', primary: '#22d3ee', secondary: '#2dd4bf' },
        // { id: 'coffee', name: 'Coffee', primary: '#c9a26d', secondary: '#d4a574' },
        { id: 'nasa', name: 'NASA', primary: '#105bd8', secondary: '#0b3d91' },
        { id: 'minimal', name: 'Minimal', primary: '#9ca3af', secondary: '#d1d5db' },
        { id: 'catppuccin', name: 'Catppuccin', primary: '#cba6f7', secondary: '#f5c2e7' },
    ],
    darkOnly: [
        { id: 'synthwave', name: 'Synthwave', primary: '#e879f9', secondary: '#22d3ee' },
        { id: 'dracula', name: 'Dracula', primary: '#bd93f9', secondary: '#44475a' },
        { id: 'midnight', name: 'Midnight', primary: '#ef4444', secondary: '#f97316' },
        { id: 'cyberpunk', name: 'Cyberpink', primary: '#ff00ff', secondary: '#00f0ff' },
        { id: 'halloween', name: 'Halloween', primary: '#f97316', secondary: '#22c55e' },
        { id: 'sunset', name: 'Sunset', primary: '#fb923c', secondary: '#facc15' },
        { id: 'gamer', name: 'Gamer', primary: '#00ff00', secondary: '#141414' },
        { id: 'nuked', name: 'Nuked', primary: '#1aff80', secondary: '#10b860' },
    ]
};
const DARK_ONLY_IDS = new Set(THEME_DATA.darkOnly.map(t => t.id));

// Theme toggle
function initTheme() {
    const themeSelectBtn = document.getElementById('theme-select-btn');
    const currentThemeNameEl = document.getElementById('current-theme-name');
    const themeModal = document.getElementById('theme-modal');
    const closeThemeModalBtn = document.getElementById('close-theme-modal');
    const themeModeLightBtn = document.getElementById('theme-mode-light');
    const themeModeDarkBtn = document.getElementById('theme-mode-dark');
    const themeGridStandard = document.getElementById('theme-grid-standard');
    const themeGridDark = document.getElementById('theme-grid-dark');
    const themeModalPartyBtn = document.getElementById('party-mode-btn');
    const amoledToggle = document.getElementById('theme-amoled-toggle');
    const amoledRow = document.getElementById('theme-amoled-row');
    const gradientCheckbox = document.getElementById('gradient-checkbox');
    const autoModeCheckbox = document.getElementById('auto-mode-checkbox');
    const autoTypeContainer = document.getElementById('auto-type-container');
    const autoTypeSelect = document.getElementById('auto-type-select');
    const scheduleTimesContainer = document.getElementById('schedule-times-container');
    const dayStartTime = document.getElementById('day-start-time');
    const nightStartTime = document.getElementById('night-start-time');

    // Migrate old theme settings to new format
    let savedTheme = localStorage.getItem('theme') || 'lavender-dark';
    if (savedTheme === 'dark') savedTheme = 'lavender-dark';
    if (savedTheme === 'light') savedTheme = 'lavender-light';

    // Extract base theme and mode from saved theme
    let themeBase = localStorage.getItem('themeBase');
    let themeMode = localStorage.getItem('themeMode') || 'dark'; // light or dark (manual selection)
    let autoEnabled = localStorage.getItem('autoModeEnabled') === 'true';
    let autoType = localStorage.getItem('autoType') || 'system'; // system or scheduled
    let amoledEnabled = localStorage.getItem('amoledEnabled') === 'true';

    // Schedule times (default: 7am day, 7pm night)
    let dayStart = localStorage.getItem('dayStartTime') || '07:00';
    let nightStart = localStorage.getItem('nightStartTime') || '19:00';

    // Migration from old format (auto/scheduled modes become autoEnabled + autoType)
    if (!themeBase) {
        const match = savedTheme.match(/^(.+)-(light|dark)$/);
        if (match) {
            themeBase = match[1];
            themeMode = match[2];
        } else {
            themeBase = 'lavender';
            themeMode = 'dark';
        }
        localStorage.setItem('themeBase', themeBase);
        localStorage.setItem('themeMode', themeMode);
    }
    // Fix themeBase if it still contains -light or -dark suffix
    if (themeBase && themeBase.match(/-(light|dark)$/)) {
        const match = themeBase.match(/^(.+)-(light|dark)$/);
        if (match) {
            themeBase = match[1];
            themeMode = match[2];
            localStorage.setItem('themeBase', themeBase);
            localStorage.setItem('themeMode', themeMode);
        }
    }
    // Migrate old auto/scheduled modes
    if (themeMode === 'auto') {
        autoEnabled = true;
        autoType = 'system';
        themeMode = 'dark';
        localStorage.setItem('autoModeEnabled', 'true');
        localStorage.setItem('autoType', 'system');
        localStorage.setItem('themeMode', 'dark');
    } else if (themeMode === 'scheduled') {
        autoEnabled = true;
        autoType = 'scheduled';
        themeMode = 'dark';
        localStorage.setItem('autoModeEnabled', 'true');
        localStorage.setItem('autoType', 'scheduled');
        localStorage.setItem('themeMode', 'dark');
    }

    // Check if current time is within day hours
    function isDayTime() {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const [dayH, dayM] = dayStart.split(':').map(Number);
        const [nightH, nightM] = nightStart.split(':').map(Number);
        const dayMinutes = dayH * 60 + dayM;
        const nightMinutes = nightH * 60 + nightM;

        if (dayMinutes < nightMinutes) {
            return currentMinutes >= dayMinutes && currentMinutes < nightMinutes;
        } else {
            return currentMinutes >= dayMinutes || currentMinutes < nightMinutes;
        }
    }

    // Get effective mode (resolves auto to actual light/dark)
    function getEffectiveMode() {
        if (autoEnabled) {
            if (autoType === 'system') {
                return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            } else {
                return isDayTime() ? 'light' : 'dark';
            }
        }
        return themeMode;
    }

    // Apply initial theme
    const effectiveMode = getEffectiveMode();
    const fullTheme = `${themeBase}-${effectiveMode}`;
    document.documentElement.setAttribute('data-theme', fullTheme);
    document.documentElement.setAttribute('data-amoled', amoledEnabled);
    localStorage.setItem('theme', fullTheme);

    // Gradient setting (default off)
    const useGradient = localStorage.getItem('useGradient') === 'true';
    document.documentElement.setAttribute('data-gradient', useGradient);

    // Get display name for a theme id
    function getThemeDisplayName(id) {
        const all = [...THEME_DATA.standard, ...THEME_DATA.darkOnly];
        const t = all.find(t => t.id === id);
        return t ? t.name : id.charAt(0).toUpperCase() + id.slice(1);
    }

    // Update the theme button label
    function updateThemeButtonName() {
        if (currentThemeNameEl) {
            currentThemeNameEl.textContent = getThemeDisplayName(themeBase);
        }
    }

    // Render swatch grid
    function renderThemeGrid() {
        function buildSwatches(themes, container) {
            if (!container) return;
            container.innerHTML = '';
            themes.forEach(t => {
                const swatch = document.createElement('div');
                swatch.className = 'theme-swatch' + (t.id === themeBase ? ' selected' : '');
                swatch.dataset.themeId = t.id;
                swatch.innerHTML = `<div class="theme-swatch-color" style="background: ${t.primary}; --swatch-secondary: ${t.secondary};"></div><span class="theme-swatch-name">${t.name}</span>`;
                swatch.addEventListener('click', () => {
                    themeBase = t.id;
                    // Dark-only enforcement
                    if (DARK_ONLY_IDS.has(t.id)) {
                        themeMode = 'dark';
                        autoEnabled = false;
                        if (autoModeCheckbox) autoModeCheckbox.checked = false;
                    }
                    applyTheme();
                    updateThemeButtonName();
                    renderThemeGrid();
                    if (window.applyThemeMascot) window.applyThemeMascot(themeBase);
                    showToast(`Theme: ${t.name}`);
                });
                container.appendChild(swatch);
            });
        }
        buildSwatches(THEME_DATA.standard, themeGridStandard);
        buildSwatches(THEME_DATA.darkOnly, themeGridDark);
    }

    // Update UI states
    function updateUI() {
        const currentEffective = getEffectiveMode();
        const isDarkOnly = DARK_ONLY_IDS.has(themeBase);
        if (themeModeLightBtn && themeModeDarkBtn) {
            themeModeLightBtn.classList.toggle('active', currentEffective === 'light' && !isDarkOnly);
            themeModeLightBtn.classList.toggle('disabled', isDarkOnly);
            themeModeLightBtn.disabled = isDarkOnly;
            themeModeDarkBtn.classList.toggle('active', currentEffective === 'dark' || isDarkOnly);
            const modeToggle = themeModeLightBtn.closest('.theme-mode-toggle');
            if (modeToggle) modeToggle.style.display = isDarkOnly ? 'none' : '';
        }
        const hdrToggle = document.getElementById('header-theme-toggle');
        if (hdrToggle) {
            const userWantsToggle = localStorage.getItem('showHeaderThemeToggle') !== 'false';
            hdrToggle.style.display = (!isDarkOnly && userWantsToggle) ? 'flex' : 'none';
        }
        if (autoModeCheckbox) {
            autoModeCheckbox.checked = autoEnabled;
        }
        if (autoTypeContainer) {
            autoTypeContainer.style.display = autoEnabled ? 'flex' : 'none';
        }
        if (autoTypeSelect) {
            autoTypeSelect.value = autoType;
        }
        if (scheduleTimesContainer) {
            scheduleTimesContainer.style.display = (autoEnabled && autoType === 'scheduled') ? 'flex' : 'none';
        }
        // AMOLED toggle: disabled in light mode
        if (amoledToggle && amoledRow) {
            const isLight = currentEffective === 'light';
            amoledToggle.checked = amoledEnabled;
            amoledToggle.disabled = isLight;
            amoledRow.classList.toggle('disabled', isLight);
        }
        updateThemeButtonName();
    }

    // Apply theme helper
    function applyTheme() {
        const effectiveMode = getEffectiveMode();
        const fullTheme = `${themeBase}-${effectiveMode}`;
        document.documentElement.setAttribute('data-theme', fullTheme);
        localStorage.setItem('theme', fullTheme);
        localStorage.setItem('themeBase', themeBase);
        localStorage.setItem('themeMode', themeMode);
        localStorage.setItem('autoModeEnabled', autoEnabled);
        localStorage.setItem('autoType', autoType);
        document.documentElement.setAttribute('data-amoled', amoledEnabled);
        updateUI();
    }

    // Listen for system theme changes when in auto system mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (autoEnabled && autoType === 'system') {
            applyTheme();
        }
    });

    // Check scheduled theme every minute
    setInterval(() => {
        if (autoEnabled && autoType === 'scheduled') {
            applyTheme();
        }
    }, 60000);

    // Theme modal open/close
    if (themeSelectBtn && themeModal) {
        themeSelectBtn.addEventListener('click', () => {
            renderThemeGrid();
            themeModal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
        });
        themeModal.addEventListener('click', (e) => {
            if (e.target === themeModal) {
                themeModal.style.display = 'none';
                document.body.style.overflow = '';
                syncSettingsToServer();
            }
        });
    }
    if (closeThemeModalBtn && themeModal) {
        closeThemeModalBtn.addEventListener('click', () => {
            themeModal.style.display = 'none';
            document.body.style.overflow = '';
            syncSettingsToServer();
        });
    }

    // Modal Light/Dark toggle
    if (themeModeLightBtn) {
        themeModeLightBtn.addEventListener('click', () => {
            // If current theme is dark-only, switch to lavender
            if (DARK_ONLY_IDS.has(themeBase)) {
                themeBase = 'lavender';
                if (window.applyThemeMascot) window.applyThemeMascot(themeBase);
            }
            themeMode = 'light';
            autoEnabled = false;
            if (autoModeCheckbox) autoModeCheckbox.checked = false;
            applyTheme();
            renderThemeGrid();
            showToast('Light mode enabled');
        });
    }
    if (themeModeDarkBtn) {
        themeModeDarkBtn.addEventListener('click', () => {
            themeMode = 'dark';
            autoEnabled = false;
            if (autoModeCheckbox) autoModeCheckbox.checked = false;
            applyTheme();
            renderThemeGrid();
            showToast('Dark mode enabled');
        });
    }

    // AMOLED toggle
    if (amoledToggle) {
        amoledToggle.addEventListener('change', () => {
            amoledEnabled = amoledToggle.checked;
            localStorage.setItem('amoledEnabled', amoledEnabled);
            applyTheme();
            showToast(amoledEnabled ? 'AMOLED mode enabled' : 'AMOLED mode disabled');
        });
    }

    if (autoModeCheckbox) {
        autoModeCheckbox.addEventListener('change', () => {
            autoEnabled = autoModeCheckbox.checked;
            applyTheme();
            showToast(autoEnabled ? 'Auto switch enabled' : 'Auto switch disabled');
        });
    }

    if (autoTypeSelect) {
        autoTypeSelect.addEventListener('change', () => {
            autoType = autoTypeSelect.value;
            applyTheme();
            showToast(autoType === 'system' ? 'Using system preference' : 'Using schedule');
        });
    }

    // Schedule time inputs
    if (dayStartTime) {
        dayStartTime.value = dayStart;
        dayStartTime.addEventListener('change', () => {
            dayStart = dayStartTime.value;
            localStorage.setItem('dayStartTime', dayStart);
            if (autoEnabled && autoType === 'scheduled') {
                applyTheme();
            }
        });
    }

    if (nightStartTime) {
        nightStartTime.value = nightStart;
        nightStartTime.addEventListener('change', () => {
            nightStart = nightStartTime.value;
            localStorage.setItem('nightStartTime', nightStart);
            if (autoEnabled && autoType === 'scheduled') {
                applyTheme();
            }
        });
    }

    updateUI();

    if (gradientCheckbox) {
        gradientCheckbox.checked = useGradient;

        gradientCheckbox.addEventListener('change', () => {
            const newGradient = gradientCheckbox.checked;
            document.documentElement.setAttribute('data-gradient', newGradient);
            localStorage.setItem('useGradient', newGradient);
            showToast(newGradient ? 'Gradient enabled' : 'Gradient disabled');
        });
    }

    // Tagline customization
    const taglineInput = document.getElementById('tagline-input');
    const headerTagline = document.getElementById('header-tagline');
    const defaultTagline = 'Your self-hosted crochet companion';
    const savedTagline = localStorage.getItem('tagline') || defaultTagline;

    if (headerTagline) {
        headerTagline.textContent = savedTagline;
    }

    if (taglineInput) {
        taglineInput.value = savedTagline;

        taglineInput.addEventListener('input', () => {
            const newTagline = taglineInput.value || defaultTagline;
            if (headerTagline) {
                headerTagline.textContent = newTagline;
            }
            localStorage.setItem('tagline', newTagline);
        });
    }

    // Logo toggle
    const showLogoCheckbox = document.getElementById('show-logo-checkbox');
    const headerLogo = document.getElementById('header-logo');
    const showLogo = localStorage.getItem('showLogo') !== 'false';

    if (headerLogo) {
        headerLogo.style.display = showLogo ? 'inline' : 'none';
    }

    if (showLogoCheckbox) {
        showLogoCheckbox.checked = showLogo;

        showLogoCheckbox.addEventListener('change', () => {
            const show = showLogoCheckbox.checked;
            localStorage.setItem('showLogo', show);
            if (headerLogo) {
                headerLogo.style.display = show ? 'inline' : 'none';
            }
            showToast(show ? 'Logo shown' : 'Logo hidden');
        });
    }

    // Mascot selector
    const mascotSelectBtn = document.getElementById('mascot-select-btn');
    const mascotModal = document.getElementById('mascot-modal');
    const mascotGrid = document.getElementById('mascot-grid');
    const closeMascotModal = document.getElementById('close-mascot-modal');
    const themeMascotCheckbox = document.getElementById('theme-mascot-checkbox');
    const headerLogoImg = headerLogo ? headerLogo.querySelector('img') : null;
    const favicon = document.querySelector('link[rel="icon"]');
    const currentMascotName = document.getElementById('current-mascot-name');
    let mascotsList = [];
    let themeMascotEnabled = localStorage.getItem('themeMascotEnabled') === 'true';

    // Parse mascot filename: name.theme.ext or name.ext
    // Returns { name: 'Display Name', theme: 'themename' or null }
    function parseMascotFilename(filename) {
        const withoutExt = filename.replace(/\.[^/.]+$/, '');
        const parts = withoutExt.split('.');

        // Capitalize name: replace hyphens with spaces, title case each word
        const capitalize = (str) => str
            .replace(/-/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        if (parts.length >= 2) {
            // Has theme: name.theme
            const theme = parts.pop().toLowerCase();
            const name = capitalize(parts.join('.'));
            return { name, theme };
        } else {
            // No theme: just name
            const name = capitalize(withoutExt);
            return { name, theme: null };
        }
    }

    function getMascotDisplayName(url) {
        const mascot = mascotsList.find(m => m.url === url);
        if (!mascot) return 'Default';
        return parseMascotFilename(mascot.filename).name;
    }

    function updateMascotButtonName() {
        if (!currentMascotName) return;
        const savedMascot = localStorage.getItem('selectedMascot') || (mascotsList[0]?.url || '');
        currentMascotName.textContent = getMascotDisplayName(savedMascot);
    }

    function setMascot(url) {
        if (headerLogoImg) {
            headerLogoImg.src = url;
        }
        if (favicon) {
            favicon.href = url;
        }
    }

    // Find mascot matching theme name (case-insensitive)
    function findThemeMascot(themeName) {
        return mascotsList.find(m => {
            const parsed = parseMascotFilename(m.filename);
            return parsed.theme === themeName.toLowerCase();
        });
    }

    // Apply mascot for current theme (called when theme changes)
    window.applyThemeMascot = function(themeName) {
        if (!themeMascotEnabled) return;
        const themeMascot = findThemeMascot(themeName);
        if (themeMascot) {
            setMascot(themeMascot.url);
        }
    };

    // Set random mascot (called by party mode)
    window.setRandomMascot = function() {
        if (mascotsList.length > 0) {
            const randomMascot = mascotsList[Math.floor(Math.random() * mascotsList.length)];
            setMascot(randomMascot.url);
            localStorage.setItem('selectedMascot', randomMascot.url);
        }
    };

    async function loadMascots() {
        try {
            const response = await fetch('/api/mascots');
            if (!response.ok) return;
            mascotsList = await response.json();

            // Preload all mascot images so the picker opens instantly
            mascotsList.forEach(m => { new Image().src = m.url; });

            // Apply saved mascot on load (or theme mascot if enabled)
            if (mascotsList.length > 0) {
                if (themeMascotEnabled) {
                    const currentTheme = localStorage.getItem('themeBase') || 'lavender';
                    const themeMascot = findThemeMascot(currentTheme);
                    if (themeMascot) {
                        setMascot(themeMascot.url);
                    } else {
                        const savedMascot = localStorage.getItem('selectedMascot') || mascotsList[0].url;
                        setMascot(savedMascot);
                    }
                } else {
                    const savedMascot = localStorage.getItem('selectedMascot') || mascotsList[0].url;
                    setMascot(savedMascot);
                }
                updateMascotButtonName();
            }
        } catch (error) {
            console.error('Error loading mascots:', error);
        }
    }

    function renderMascotGrid() {
        if (!mascotGrid) return;

        const savedMascot = localStorage.getItem('selectedMascot') || (mascotsList[0]?.url || '');

        if (mascotsList.length === 0) {
            mascotGrid.innerHTML = '<p>No mascots found. Add images to the mascots folder.</p>';
            return;
        }

        mascotGrid.innerHTML = mascotsList.map(m => {
            const displayName = parseMascotFilename(m.filename).name;
            const isSelected = m.url === savedMascot;
            return `
                <div class="mascot-item${isSelected ? ' selected' : ''}" data-url="${m.url}">
                    <img src="${m.url}" alt="${displayName}">
                    <span>${displayName}</span>
                </div>
            `;
        }).join('');

        // Add click handlers
        mascotGrid.querySelectorAll('.mascot-item').forEach(item => {
            item.addEventListener('click', () => {
                const url = item.dataset.url;
                localStorage.setItem('selectedMascot', url);
                setMascot(url);
                updateMascotButtonName();
                mascotModal.style.display = 'none';
                showToast('Mascot updated');
            });
        });
    }

    if (mascotSelectBtn) {
        mascotSelectBtn.addEventListener('click', () => {
            renderMascotGrid();
            mascotModal.style.display = 'flex';
        });
    }

    if (closeMascotModal) {
        closeMascotModal.addEventListener('click', () => {
            mascotModal.style.display = 'none';
        });
    }

    if (mascotModal) {
        mascotModal.addEventListener('click', (e) => {
            if (e.target === mascotModal) {
                mascotModal.style.display = 'none';
            }
        });
    }

    // Theme mascot toggle
    if (themeMascotCheckbox) {
        themeMascotCheckbox.checked = themeMascotEnabled;
        themeMascotCheckbox.addEventListener('change', () => {
            themeMascotEnabled = themeMascotCheckbox.checked;
            localStorage.setItem('themeMascotEnabled', themeMascotEnabled);
            if (themeMascotEnabled) {
                const currentTheme = localStorage.getItem('themeBase') || 'lavender';
                const themeMascot = findThemeMascot(currentTheme);
                if (themeMascot) {
                    setMascot(themeMascot.url);
                    showToast('Theme mascot enabled');
                } else {
                    showToast('No mascot for this theme');
                }
            } else {
                const savedMascot = localStorage.getItem('selectedMascot') || (mascotsList[0]?.url || '');
                setMascot(savedMascot);
                showToast('Theme mascot disabled');
            }
        });
    }

    loadMascots();

    // Mascot home link
    const mascotHomeLink = document.getElementById('mascot-home-link');
    if (mascotHomeLink) {
        mascotHomeLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const mascotAction = localStorage.getItem('mascotAction') || 'home';
            if (mascotAction === 'recent') {
                try {
                    const res = await fetch(`${API_URL}/api/patterns/recent`);
                    if (res.ok) {
                        const { id } = await res.json();
                        if (id) { openPDFViewer(id); return; }
                    }
                } catch (e) {}
            } else if (mascotAction === 'ravelry') {
                switchToTab('settings');
                switchToSettingsSection('ravelry');
                return;
            }
            const defaultPage = localStorage.getItem('defaultPage') || 'current';
            switchToTab(defaultPage);
        });
    }

    // Mascot action setting
    const mascotActionSelect = document.getElementById('mascot-action-select');
    if (mascotActionSelect) {
        mascotActionSelect.value = localStorage.getItem('mascotAction') || 'home';
        mascotActionSelect.addEventListener('change', () => {
            localStorage.setItem('mascotAction', mascotActionSelect.value);
            const label = mascotActionSelect.options[mascotActionSelect.selectedIndex].text;
            showToast(`Mascot action: ${label}`);
        });
    }

    // Header theme toggle button
    const headerThemeToggle = document.getElementById('header-theme-toggle');
    const showHeaderThemeToggleCheckbox = document.getElementById('show-header-theme-toggle-checkbox');
    const showHeaderThemeToggle = localStorage.getItem('showHeaderThemeToggle') !== 'false';

    if (headerThemeToggle) {
        headerThemeToggle.style.display = (showHeaderThemeToggle && !DARK_ONLY_IDS.has(themeBase)) ? 'flex' : 'none';

        headerThemeToggle.addEventListener('click', () => {
            if (themeMode === 'dark') {
                // Switching to light - if dark-only theme, fall back to lavender
                if (DARK_ONLY_IDS.has(themeBase)) {
                    themeBase = 'lavender';
                    updateThemeButtonName();
                    if (window.applyThemeMascot) window.applyThemeMascot(themeBase);
                }
                themeMode = 'light';
            } else {
                themeMode = 'dark';
            }
            autoEnabled = false;
            applyTheme();
            syncSettingsToServer();
            if (autoModeCheckbox) autoModeCheckbox.checked = false;
            showToast(themeMode === 'dark' ? 'Dark mode enabled' : 'Light mode enabled');
        });
    }

    if (showHeaderThemeToggleCheckbox) {
        showHeaderThemeToggleCheckbox.checked = showHeaderThemeToggle;

        showHeaderThemeToggleCheckbox.addEventListener('change', () => {
            const show = showHeaderThemeToggleCheckbox.checked;
            localStorage.setItem('showHeaderThemeToggle', show);
            if (headerThemeToggle) {
                headerThemeToggle.style.display = (show && !DARK_ONLY_IDS.has(themeBase)) ? 'flex' : 'none';
            }
            showToast(show ? 'Theme toggle shown' : 'Theme toggle hidden');
        });
    }

    // Tagline visibility toggle
    const showTaglineCheckbox = document.getElementById('show-tagline-checkbox');
    const taglineInputContainer = document.getElementById('tagline-input-container');
    const showTagline = localStorage.getItem('showTagline') !== 'false';

    if (headerTagline) {
        headerTagline.style.display = showTagline ? 'block' : 'none';
    }

    if (taglineInputContainer) {
        taglineInputContainer.style.display = showTagline ? 'flex' : 'none';
    }

    if (showTaglineCheckbox) {
        showTaglineCheckbox.checked = showTagline;

        showTaglineCheckbox.addEventListener('change', () => {
            const show = showTaglineCheckbox.checked;
            localStorage.setItem('showTagline', show);
            if (headerTagline) {
                headerTagline.style.display = show ? 'block' : 'none';
            }
            if (taglineInputContainer) {
                taglineInputContainer.style.display = show ? 'flex' : 'none';
            }
            showToast(show ? 'Tagline shown' : 'Tagline hidden');
        });
    }

    // Haptic feedback toggle
    const hapticCheckbox = document.getElementById('haptic-checkbox');
    const hapticEnabled = localStorage.getItem('hapticFeedback') !== 'false';

    if (hapticCheckbox) {
        hapticCheckbox.checked = hapticEnabled;

        hapticCheckbox.addEventListener('change', () => {
            const enabled = hapticCheckbox.checked;
            localStorage.setItem('hapticFeedback', enabled);
            showToast(enabled ? 'Haptic feedback enabled' : 'Haptic feedback disabled');
        });
    }

    // What's New popup setting
    const whatsNewCheckbox = document.getElementById('whats-new-checkbox');
    const whatsNewEnabled = localStorage.getItem('showWhatsNew') !== 'false';

    if (whatsNewCheckbox) {
        whatsNewCheckbox.checked = whatsNewEnabled;

        whatsNewCheckbox.addEventListener('change', () => {
            const enabled = whatsNewCheckbox.checked;
            localStorage.setItem('showWhatsNew', enabled);
            showToast(enabled ? 'What\'s New popup enabled' : 'What\'s New popup disabled');
        });
    }

    // Wake lock setting
    const wakeLockCheckbox = document.getElementById('wake-lock-checkbox');
    const wakeLockEnabled = localStorage.getItem('wakeLock') === 'true';

    if (wakeLockCheckbox) {
        wakeLockCheckbox.checked = wakeLockEnabled;

        wakeLockCheckbox.addEventListener('change', () => {
            const enabled = wakeLockCheckbox.checked;
            localStorage.setItem('wakeLock', enabled);
            showToast(enabled ? 'Screen wake lock enabled' : 'Screen wake lock disabled');
            if (!enabled) releaseWakeLock();
        });
    }

    // Counter layout setting
    const counterLayoutSelect = document.getElementById('counter-layout-select');
    const savedCounterLayout = localStorage.getItem('counterLayout') || 'stack';
    if (counterLayoutSelect) {
        counterLayoutSelect.value = savedCounterLayout;
        counterLayoutSelect.addEventListener('change', () => {
            localStorage.setItem('counterLayout', counterLayoutSelect.value);
            applyCounterLayout();
        });
    }

    // Font selection
    const fontSelect = document.getElementById('font-select');
    const customFontContainer = document.getElementById('custom-font-container');
    const customFontInput = document.getElementById('custom-font-input');
    const applyCustomFontBtn = document.getElementById('apply-custom-font-btn');

    const savedFont = localStorage.getItem('fontFamily') || 'JetBrains Mono';
    const savedCustomFont = localStorage.getItem('customFontName') || '';

    // Apply saved font on load
    applyFont(savedFont, savedCustomFont);

    if (fontSelect) {
        // Check if saved font is a preset or custom
        const isPreset = Array.from(fontSelect.options).some(opt => opt.value === savedFont && opt.value !== 'custom');
        if (isPreset) {
            fontSelect.value = savedFont;
        } else if (savedCustomFont) {
            fontSelect.value = 'custom';
            if (customFontContainer) customFontContainer.style.display = 'flex';
            if (customFontInput) customFontInput.value = savedCustomFont;
        }

        fontSelect.addEventListener('change', () => {
            const selectedFont = fontSelect.value;
            if (selectedFont === 'custom') {
                if (customFontContainer) customFontContainer.style.display = 'flex';
            } else {
                if (customFontContainer) customFontContainer.style.display = 'none';
                applyFont(selectedFont);
                localStorage.setItem('fontFamily', selectedFont);
                localStorage.removeItem('customFontName');
                showToast(`Font changed to ${selectedFont}`);
            }
        });
    }

    if (applyCustomFontBtn && customFontInput) {
        applyCustomFontBtn.addEventListener('click', () => {
            const customFont = customFontInput.value.trim();
            if (customFont) {
                applyFont(customFont, customFont);
                localStorage.setItem('fontFamily', customFont);
                localStorage.setItem('customFontName', customFont);
                showToast(`Font changed to ${customFont}`);
            }
        });

        customFontInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                applyCustomFontBtn.click();
            }
        });
    }

    // Party mode (Surprise Me!) - random theme, font, and mascot
    if (themeModalPartyBtn) {
        themeModalPartyBtn.addEventListener('click', async () => {
            const allThemes = [...THEME_DATA.standard, ...THEME_DATA.darkOnly];
            const fonts = ['JetBrains Mono', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Nunito', 'Raleway', 'Source Sans Pro', 'Ubuntu', 'Fira Sans'];

            const randomTheme = allThemes[Math.floor(Math.random() * allThemes.length)];
            const randomFont = fonts[Math.floor(Math.random() * fonts.length)];

            // Apply random theme
            themeBase = randomTheme.id;
            if (DARK_ONLY_IDS.has(themeBase)) {
                themeMode = 'dark';
                autoEnabled = false;
                if (autoModeCheckbox) autoModeCheckbox.checked = false;
            }
            applyTheme();
            updateThemeButtonName();
            renderThemeGrid();

            // Apply random font
            applyFont(randomFont);
            localStorage.setItem('fontFamily', randomFont);
            localStorage.removeItem('customFontName');
            if (fontSelect) {
                fontSelect.value = randomFont;
                if (customFontContainer) customFontContainer.style.display = 'none';
            }

            // Apply random mascot
            if (window.setRandomMascot) {
                window.setRandomMascot();
            }

            showToast(`Surprise! Theme: ${randomTheme.name}, Font: ${randomFont}`);
        });
    }

    // Reset appearance to defaults
    const resetAppearanceBtn = document.getElementById('reset-appearance-btn');
    if (resetAppearanceBtn) {
        resetAppearanceBtn.addEventListener('click', () => {
            // Reset theme
            localStorage.setItem('theme', 'lavender-dark');
            localStorage.setItem('themeBase', 'lavender');
            localStorage.setItem('themeMode', 'dark');
            localStorage.setItem('autoModeEnabled', 'false');
            localStorage.setItem('autoType', 'system');
            localStorage.setItem('dayStartTime', '07:00');
            localStorage.setItem('nightStartTime', '19:00');
            document.documentElement.setAttribute('data-theme', 'lavender-dark');
            themeBase = 'lavender';
            themeMode = 'dark';
            autoEnabled = false;
            amoledEnabled = false;
            localStorage.setItem('amoledEnabled', 'false');
            document.documentElement.setAttribute('data-amoled', 'false');
            if (amoledToggle) amoledToggle.checked = false;
            updateThemeButtonName();
            if (autoModeCheckbox) autoModeCheckbox.checked = false;
            if (autoTypeContainer) autoTypeContainer.style.display = 'none';
            if (autoTypeSelect) autoTypeSelect.value = 'system';
            if (scheduleTimesContainer) scheduleTimesContainer.style.display = 'none';
            if (dayStartTime) dayStartTime.value = '07:00';
            if (nightStartTime) nightStartTime.value = '19:00';

            // Reset gradient
            localStorage.setItem('useGradient', 'false');
            document.documentElement.setAttribute('data-gradient', 'false');
            if (gradientCheckbox) gradientCheckbox.checked = false;

            // Reset tagline
            localStorage.setItem('tagline', defaultTagline);
            if (headerTagline) headerTagline.textContent = defaultTagline;
            if (taglineInput) taglineInput.value = defaultTagline;

            // Reset tagline visibility
            localStorage.setItem('showTagline', 'true');
            if (headerTagline) headerTagline.style.display = 'block';
            if (showTaglineCheckbox) showTaglineCheckbox.checked = true;
            if (taglineInputContainer) taglineInputContainer.style.display = 'flex';

            // Reset logo
            localStorage.setItem('showLogo', 'true');
            if (headerLogo) headerLogo.style.display = 'inline';
            if (showLogoCheckbox) showLogoCheckbox.checked = true;

            // Reset header theme toggle
            localStorage.setItem('showHeaderThemeToggle', 'true');
            if (headerThemeToggle) headerThemeToggle.style.display = 'flex';
            if (showHeaderThemeToggleCheckbox) showHeaderThemeToggleCheckbox.checked = true;

            // Reset font
            localStorage.setItem('fontFamily', 'JetBrains Mono');
            localStorage.removeItem('customFontName');
            applyFont('JetBrains Mono');
            if (fontSelect) fontSelect.value = 'JetBrains Mono';
            if (customFontContainer) customFontContainer.style.display = 'none';
            if (customFontInput) customFontInput.value = '';

            // Reset mascot
            localStorage.removeItem('selectedMascot');
            localStorage.setItem('themeMascotEnabled', 'false');
            const themeMascotCheckbox = document.getElementById('theme-mascot-checkbox');
            if (themeMascotCheckbox) themeMascotCheckbox.checked = false;
            // Set mascot to default (first in list)
            fetch('/api/mascots')
                .then(res => res.ok ? res.json() : Promise.reject('Failed to load mascots'))
                .then(mascots => {
                    if (mascots.length > 0) {
                        const defaultMascot = mascots[0].url;
                        localStorage.setItem('selectedMascot', defaultMascot);
                        const mascotImg = document.getElementById('header-mascot-img');
                        if (mascotImg) mascotImg.src = defaultMascot;
                        // Update button name
                        const nameSpan = document.getElementById('current-mascot-name');
                        if (nameSpan) {
                            const displayName = mascots[0].filename
                                .replace(/\.[^/.]+$/, '')
                                .replace(/-/g, ' ')
                                .replace(/\b\w/g, c => c.toUpperCase());
                            nameSpan.textContent = displayName;
                        }
                        // Update grid selection if visible
                        document.querySelectorAll('.mascot-item').forEach(item => {
                            item.classList.toggle('selected', item.dataset.url === defaultMascot);
                        });
                    }
                });

            showToast('Appearance reset to defaults');
        });
    }

    // Reset behavior to defaults
    const resetBehaviorBtn = document.getElementById('reset-behavior-btn');
    if (resetBehaviorBtn) {
        resetBehaviorBtn.addEventListener('click', () => {
            // Reset tab counts
            localStorage.setItem('showTabCounts', 'true');
            showTabCounts = true;
            const tabCountsCheckbox = document.getElementById('tab-counts-checkbox');
            if (tabCountsCheckbox) tabCountsCheckbox.checked = true;
            updateTabCounts();

            // Reset default page
            localStorage.setItem('defaultPage', 'current');
            const defaultPageSelect = document.getElementById('default-page-select');
            if (defaultPageSelect) defaultPageSelect.value = 'current';

            // Reset inventory tab
            localStorage.setItem('showInventoryTab', 'true');
            showInventoryTab = true;
            const showInvCheckbox = document.getElementById('show-inventory-checkbox');
            if (showInvCheckbox) showInvCheckbox.checked = true;
            applyInventoryTabVisibility();

            // Reset auto-current on timer
            localStorage.setItem('autoCurrentOnTimer', 'false');
            autoCurrentOnTimer = false;
            const autoCurrentTimerCheckbox = document.getElementById('auto-current-timer-checkbox');
            if (autoCurrentTimerCheckbox) autoCurrentTimerCheckbox.checked = false;

            // Reset auto timer default
            localStorage.setItem('autoTimerDefault', 'false');
            autoTimerDefault = false;
            const autoTimerDefaultCheckbox = document.getElementById('auto-timer-default-checkbox');
            if (autoTimerDefaultCheckbox) autoTimerDefaultCheckbox.checked = false;

            // Reset default zoom
            localStorage.setItem('defaultZoom', 'fit');
            const defaultZoomSelect = document.getElementById('default-zoom-select');
            if (defaultZoomSelect) defaultZoomSelect.value = 'fit';

            // Reset badges
            localStorage.setItem('showTypeBadge', 'true');
            localStorage.setItem('showStatusBadge', 'true');
            localStorage.setItem('showCategoryBadge', 'true');
            showTypeBadge = true;
            showStatusBadge = true;
            showCategoryBadge = true;
            const typeBadgeCheckbox = document.getElementById('badge-type-checkbox');
            const statusBadgeCheckbox = document.getElementById('badge-status-checkbox');
            const categoryBadgeCheckbox = document.getElementById('badge-category-checkbox');
            localStorage.setItem('showStarBadge', 'true');
            showStarBadge = true;
            const starBadgeCheckbox = document.getElementById('badge-star-checkbox');
            if (typeBadgeCheckbox) typeBadgeCheckbox.checked = true;
            if (statusBadgeCheckbox) statusBadgeCheckbox.checked = true;
            if (categoryBadgeCheckbox) categoryBadgeCheckbox.checked = true;
            if (starBadgeCheckbox) starBadgeCheckbox.checked = true;
            localStorage.setItem('showRatingBadge', 'true');
            showRatingBadge = true;
            const ratingBadgeCheckbox = document.getElementById('badge-rating-checkbox');
            if (ratingBadgeCheckbox) ratingBadgeCheckbox.checked = true;

            // Reset haptic
            localStorage.setItem('hapticEnabled', 'true');
            const hapticCheckbox = document.getElementById('haptic-checkbox');
            if (hapticCheckbox) hapticCheckbox.checked = true;

            // Reset what's new
            localStorage.setItem('whatsNewEnabled', 'true');
            const whatsNewCheckbox = document.getElementById('whats-new-checkbox');
            if (whatsNewCheckbox) whatsNewCheckbox.checked = true;

            // Reset counter layout
            localStorage.setItem('counterLayout', 'stack');
            const counterLayoutSelect = document.getElementById('counter-layout-select');
            if (counterLayoutSelect) counterLayoutSelect.value = 'stack';
            applyCounterLayout();

            // Reset wake lock
            localStorage.setItem('wakeLockEnabled', 'false');
            const wakeLockCheckbox = document.getElementById('wake-lock-checkbox');
            if (wakeLockCheckbox) wakeLockCheckbox.checked = false;

            // Reset page mode
            localStorage.setItem('pdfScrollMode', 'page');
            const pdfScrollModeSelect = document.getElementById('pdf-scroll-mode-select');
            if (pdfScrollModeSelect) pdfScrollModeSelect.value = 'page';
            const scrollPageButtonsContainer = document.getElementById('scroll-page-buttons-container');
            if (scrollPageButtonsContainer) scrollPageButtonsContainer.style.display = 'none';

            // Reset inactivity timeout
            localStorage.setItem('inactivityTimeout', '5');
            const inactivityTimeoutInput = document.getElementById('inactivity-timeout-input');
            if (inactivityTimeoutInput) inactivityTimeoutInput.value = '5';

            displayPatterns();
            showToast('Behavior reset to defaults');
        });
    }
}

// Tab switching
function initTabs() {
    // Check if we're restoring a pattern viewer - don't show tabs in that case
    const hash = window.location.hash.slice(1);
    const isOpeningPattern = hash.startsWith('pattern/');

    if (isOpeningPattern) {
        // Hide tabs, content will be shown when pattern viewer opens
        const earlyStyle = document.getElementById('early-tab-style');
        if (earlyStyle) earlyStyle.remove();
        document.querySelector('.tabs').style.display = 'none';
        tabContents.forEach(c => c.style.display = 'none');
    } else {
        // Restore last active tab
        const currentTab = localStorage.getItem('activeTab');
        const defaultPage = localStorage.getItem('defaultPage') || 'current';
        const startTab = currentTab || defaultPage;

        // If early-tab-style already set the correct tab, just sync button state
        const earlyStyle = document.getElementById('early-tab-style');
        const alreadyShowing = document.querySelector('.tab-content.active');
        if (earlyStyle && alreadyShowing && alreadyShowing.id === startTab) {
            tabBtns.forEach(b => b.classList.remove('active'));
            const btn = document.querySelector(`[data-tab="${startTab}"]`);
            if (btn) btn.classList.add('active');
            earlyStyle.remove();
        } else {
            if (earlyStyle) earlyStyle.remove();
            switchToTab(startTab, false);
        }
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            switchToTab(tabName);
            localStorage.setItem('activeTab', tabName);
        });
    });
}

function initSwipeNavigation() {
    if (!window.matchMedia('(max-width: 768px)').matches) return;

    const tabOrder = ['current', 'library', 'inventory', 'projects'];
    let startX = 0;
    let startY = 0;
    let tracking = false;

    function getVisibleTabs() {
        return tabOrder.filter(tab => {
            const btn = document.querySelector(`[data-tab="${tab}"]`);
            return btn && btn.style.display !== 'none';
        });
    }

    document.addEventListener('touchstart', (e) => {
        // Don't swipe inside PDF viewer, modals, or horizontally scrollable tables
        if (e.target.closest('#pdf-viewer-container, .modal, .settings-content, .inventory-table')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;

        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - startX;
        const diffY = endY - startY;

        // Require minimum 80px horizontal swipe, and more horizontal than vertical
        if (Math.abs(diffX) < 80 || Math.abs(diffY) > Math.abs(diffX)) return;

        const visible = getVisibleTabs();
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        const currentIdx = visible.indexOf(activeTab);
        if (currentIdx === -1) return;

        let nextIdx;
        if (diffX < 0) {
            // Swipe left → next tab
            nextIdx = currentIdx + 1;
        } else {
            // Swipe right → previous tab
            nextIdx = currentIdx - 1;
        }

        if (nextIdx >= 0 && nextIdx < visible.length) {
            switchToTab(visible[nextIdx]);
            localStorage.setItem('activeTab', visible[nextIdx]);
        }
    }, { passive: true });
}

function switchToTab(tabName, pushHistory = true) {
    // Track previous tab (but not if switching to settings)
    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (currentTab && tabName === 'settings') {
        previousTab = currentTab;
    }

    // Push to navigation history for UI back button (unless navigating back)
    if (pushHistory && !isNavigatingBack) {
        const currentView = getCurrentView();
        if (currentView && currentView !== tabName && !currentView.startsWith(tabName + '/')) {
            navigationHistory.push(currentView);
        }
        // For settings, include the section in the URL
        let urlView = tabName;
        if (tabName === 'settings') {
            const activeSection = document.querySelector('.settings-section.active');
            urlView = activeSection ? `settings/${activeSection.dataset.section}` : 'settings/appearance';
        }
        // Update browser history
        history.pushState({ view: urlView }, '', `#${urlView}`);
    }

    // Remove active from all tabs and contents
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => {
        c.classList.remove('active');
        c.style.display = 'none';
    });

    // Activate specified tab
    const btn = document.querySelector(`[data-tab="${tabName}"]`);
    if (btn) {
        btn.classList.add('active');
    }

    // Show the content (settings tab doesn't have a nav button)
    const content = document.getElementById(tabName);
    if (content) {
        content.classList.add('active');
        content.style.display = 'block';
    }

    // Hide PDF viewer, markdown viewer, project detail, and new project panel
    pdfViewerContainer.style.display = 'none';
    const markdownViewer = document.getElementById('markdown-viewer-container');
    if (markdownViewer) markdownViewer.style.display = 'none';
    const projectDetail = document.getElementById('project-detail-view');
    if (projectDetail) projectDetail.style.display = 'none';
    const newProjectPanel = document.getElementById('new-project-panel');
    if (newProjectPanel) newProjectPanel.style.display = 'none';
    document.querySelector('.tabs').style.display = 'flex';
    const mobileBottomBar = document.getElementById('mobile-bottom-bar');
    if (mobileBottomBar) mobileBottomBar.style.display = 'none';

    // Update settings button to show back when in settings
    updateSettingsButton(tabName === 'settings');

    // Load library stats when switching to settings
    if (tabName === 'settings') {
        loadLibraryStats();
    }
}

function getCurrentView() {
    // Check if viewing a pattern
    if (pdfViewerContainer && pdfViewerContainer.style.display !== 'none' && currentPattern) {
        return `pattern/${getPatternSlug(currentPattern)}`;
    }
    const markdownViewer = document.getElementById('markdown-viewer-container');
    if (markdownViewer && markdownViewer.style.display !== 'none') {
        const patternId = markdownViewer.dataset.patternId;
        if (patternId) {
            const pattern = patterns.find(p => p.id === parseInt(patternId));
            if (pattern) return `pattern/${getPatternSlug(pattern)}`;
            return `pattern/${patternId}`;
        }
    }
    // Check if in project detail view
    const projectDetailView = document.getElementById('project-detail-view');
    if (projectDetailView && projectDetailView.style.display !== 'none' && currentProjectId) {
        return `project/${currentProjectId}`;
    }
    // Check if in settings
    const settingsTab = document.getElementById('settings');
    if (settingsTab && settingsTab.classList.contains('active')) {
        const activeSection = document.querySelector('.settings-section.active');
        if (activeSection) {
            return `settings/${activeSection.dataset.section}`;
        }
        return 'settings';
    }
    // Otherwise return current tab
    return document.querySelector('.tab-btn.active')?.dataset.tab || 'current';
}

async function navigateBack() {
    if (navigationHistory.length > 0) {
        isNavigatingBack = true;
        const previousView = navigationHistory.pop();
        // Just update the view, don't call history.back() as it causes double navigation
        await navigateToView(previousView, false);
        // Update URL without triggering popstate
        history.replaceState({ view: previousView }, '', `#${previousView}`);
        isNavigatingBack = false;
    } else {
        // Default: go to library
        switchToTab('library', false);
        history.replaceState({ view: 'library' }, '', '#library');
    }
}

async function navigateToView(view, pushHistory = true) {
    if (view.startsWith('pattern/')) {
        const slug = view.split('/')[1];
        // Try to find pattern by slug first, then by ID for backwards compatibility
        let pattern = findPatternBySlug(slug);
        if (!pattern && !isNaN(parseInt(slug))) {
            pattern = patterns.find(p => p.id === parseInt(slug));
        }
        // Handle slug-with-id format (e.g., "my-pattern-42" for duplicate slugs)
        if (!pattern) {
            const match = slug.match(/^(.+)-(\d+)$/);
            if (match) {
                const id = parseInt(match[2]);
                pattern = patterns.find(p => p.id === id) || currentPatterns.find(p => p.id === id);
            }
        }
        if (pattern) {
            await openPDFViewer(pattern.id, pushHistory);
        }
    } else if (view.startsWith('project/')) {
        const projectId = parseInt(view.split('/')[1]);
        if (projectId) {
            await openProjectView(projectId);
        }
    } else if (view === 'new-project') {
        switchToTab('projects', false);
        showNewProjectPanel();
    } else if (view.startsWith('settings/')) {
        const section = view.split('/')[1];
        switchToTab('settings', false);
        switchToSettingsSection(section, pushHistory);
    } else {
        switchToTab(view, pushHistory);
    }
}

function updateSettingsButton(inSettings) {
    document.documentElement.classList.toggle('in-settings', inSettings);
}

// Upload functionality
function initUpload() {
    const uploadPanel = document.getElementById('upload-panel');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const uploadAllBtn = document.getElementById('upload-all-btn');
    const clearAllBtn = document.getElementById('clear-all-btn');
    const clearCompletedBtn = document.getElementById('clear-completed-btn');

    // Click to browse
    dropZone.addEventListener('click', () => fileInput.click());
    browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    // File input change - handle multiple files
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFiles(Array.from(e.target.files));
            fileInput.value = ''; // Reset input
        }
    });

    // Upload all button
    uploadAllBtn.addEventListener('click', () => uploadAllPatterns());

    // Clear all button
    clearAllBtn.addEventListener('click', (e) => clearAllStaged(e.target));

    // Clear completed uploads button
    if (clearCompletedBtn) {
        clearCompletedBtn.addEventListener('click', (e) => clearCompletedUploads(e.target));
    }
}

async function handleFiles(files) {
    // Filter only PDF files
    const pdfFiles = files.filter(f => f.type === 'application/pdf');

    if (pdfFiles.length === 0) {
        return;
    }

    // Process files one at a time to handle duplicates sequentially
    for (const file of pdfFiles) {
        const result = await processFileForStaging(file);
        if (result) {
            stagedFiles.push(result);

            // Generate thumbnail preview asynchronously
            generatePdfThumbnail(file).then(url => {
                result.thumbnailUrl = url;
                renderStagedFiles();
            }).catch(err => console.log('Could not generate thumbnail:', err));
        }
    }

    if (stagedFiles.length > 0) {
        renderStagedFiles();
        showStagingArea();
    }
}

// Check if a filename already exists in the library
function findDuplicatePattern(filename) {
    const normalizedFilename = filename.toLowerCase();
    return patterns.find(p => {
        const patternFilename = (p.filename || '').toLowerCase();
        const patternOriginalName = (p.original_name || '').toLowerCase();
        return patternFilename === normalizedFilename || patternOriginalName === normalizedFilename;
    });
}

// Generate a unique filename by appending a number
function generateUniqueName(baseName) {
    let counter = 2;
    let newName = `${baseName} (${counter})`;

    // Check both existing patterns and staged files
    while (
        patterns.some(p => (p.name || '').toLowerCase() === newName.toLowerCase()) ||
        stagedFiles.some(f => f.name.toLowerCase() === newName.toLowerCase())
    ) {
        counter++;
        newName = `${baseName} (${counter})`;
    }

    return newName;
}

// Process a single file for staging, handling duplicates
async function processFileForStaging(file) {
    const baseName = file.name.replace('.pdf', '');
    const duplicate = findDuplicatePattern(file.name);

    // Also check if already staged
    const alreadyStaged = stagedFiles.some(f =>
        f.file.name.toLowerCase() === file.name.toLowerCase()
    );

    if (alreadyStaged) {
        showToast(`${file.name} is already staged`, 'warning');
        return null;
    }

    if (duplicate) {
        // Show duplicate modal and wait for user decision
        const action = await showDuplicateModal(file.name, duplicate);

        if (action === 'skip') {
            return null;
        } else if (action === 'overwrite') {
            // Mark for overwrite - store the existing pattern ID
            return createStagedFile(file, baseName, duplicate.id);
        } else if (action === 'rename') {
            // Generate a unique name
            const newName = generateUniqueName(baseName);
            return createStagedFile(file, newName, null);
        }
    }

    return createStagedFile(file, baseName, null);
}

function createStagedFile(file, name, overwritePatternId) {
    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return {
        id: fileId,
        file: file,
        name: name,
        category: getDefaultCategory(),
        description: '',
        hashtagIds: [],
        isCurrent: false,
        status: 'staged', // staged, uploading, success, error
        progress: 0,
        error: null,
        thumbnailUrl: null,
        overwritePatternId: overwritePatternId // ID of pattern to overwrite, or null
    };
}

function showDuplicateModal(filename, existingPattern) {
    return new Promise((resolve) => {
        const modal = document.getElementById('duplicate-modal');
        const filenameEl = document.getElementById('duplicate-filename');
        const skipBtn = document.getElementById('duplicate-cancel-btn');
        const overwriteBtn = document.getElementById('duplicate-overwrite-btn');
        const renameBtn = document.getElementById('duplicate-rename-btn');
        const closeBtn = document.getElementById('close-duplicate-modal');

        filenameEl.textContent = filename;
        modal.style.display = 'flex';

        const cleanup = () => {
            modal.style.display = 'none';
            skipBtn.removeEventListener('click', handleSkip);
            overwriteBtn.removeEventListener('click', handleOverwrite);
            renameBtn.removeEventListener('click', handleRename);
            closeBtn.removeEventListener('click', handleSkip);
        };

        const handleSkip = () => {
            cleanup();
            resolve('skip');
        };

        const handleOverwrite = () => {
            cleanup();
            resolve('overwrite');
        };

        const handleRename = () => {
            cleanup();
            resolve('rename');
        };

        skipBtn.addEventListener('click', handleSkip);
        overwriteBtn.addEventListener('click', handleOverwrite);
        renameBtn.addEventListener('click', handleRename);
        closeBtn.addEventListener('click', handleSkip);
    });
}

async function generatePdfThumbnail(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const scale = 0.5;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;

    return canvas.toDataURL('image/jpeg', 0.7);
}

function showStagingArea() {
    const stagingArea = document.getElementById('staging-area');
    stagingArea.style.display = 'block';
    updateStagedCount();
}

function hideStagingArea() {
    const stagingArea = document.getElementById('staging-area');
    stagingArea.style.display = 'none';
    // Clear completed uploads when hiding
    completedUploads = [];
    renderCompletedUploads();
}

function updateStagedCount() {
    const countElement = document.getElementById('staged-count');
    countElement.textContent = stagedFiles.length;
}

function updateUploadProgress(fileId, progress) {
    // Update only the progress bar without re-rendering everything
    const fileItem = document.querySelector(`.staged-file-item[data-file-id="${fileId}"]`);
    if (fileItem) {
        const progressBar = fileItem.querySelector('.upload-progress-bar');
        const progressText = fileItem.querySelector('.upload-progress-text span:last-child');
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${progress}%`;
    }
}

function renderStagedFiles() {
    const container = document.getElementById('staged-files-list');
    const header = document.querySelector('.staging-header');
    const footer = document.querySelector('.staging-footer');

    // Count files that are actually staged (not yet uploaded/uploading)
    const pendingCount = stagedFiles.filter(f => f.status === 'staged' || f.status === 'error').length;
    const hasActiveFiles = stagedFiles.length > 0;

    // Show/hide header and footer based on whether there are staged files
    if (header) header.style.display = hasActiveFiles ? 'flex' : 'none';
    if (footer) footer.style.display = pendingCount > 0 ? 'flex' : 'none';

    // Update button text based on count
    const uploadAllBtn = document.getElementById('upload-all-btn');
    if (uploadAllBtn) {
        uploadAllBtn.textContent = pendingCount === 1 ? 'Upload' : 'Upload All';
    }

    container.innerHTML = stagedFiles.map(stagedFile => {
        const statusClass = stagedFile.status;
        const isUploading = stagedFile.status === 'uploading';
        const showProgress = stagedFile.status === 'uploading' || stagedFile.status === 'success';
        const fileSize = (stagedFile.file.size / 1024 / 1024).toFixed(2);

        let statusHTML = '';
        if (stagedFile.status === 'success') {
            statusHTML = `
                <div class="upload-status success">
                    <span class="upload-status-icon">✓</span>
                    <span>Uploaded successfully!</span>
                </div>
            `;
        } else if (stagedFile.status === 'error') {
            statusHTML = `
                <div class="upload-status error">
                    <span class="upload-status-icon">✗</span>
                    <span>Error: ${escapeHtml(stagedFile.error || 'Upload failed')}</span>
                </div>
            `;
        } else if (stagedFile.status === 'uploading') {
            statusHTML = `
                <div class="upload-status uploading">
                    <span class="upload-status-icon">⏳</span>
                    <span>Uploading...</span>
                </div>
            `;
        }

        const thumbnailHtml = stagedFile.thumbnailUrl
            ? `<img src="${stagedFile.thumbnailUrl}" alt="Preview" class="staged-file-thumbnail">`
            : `<div class="staged-file-thumbnail staged-file-thumbnail-loading"></div>`;

        return `
            <div class="staged-file-item ${statusClass}" data-file-id="${stagedFile.id}">
                <button class="staged-file-close" onclick="removeStagedFile('${stagedFile.id}')"
                        ${isUploading ? 'disabled' : ''} title="Remove">×</button>
                <div class="staged-file-layout">
                    <div class="staged-file-sidebar">
                        ${thumbnailHtml}
                        <div class="staged-file-current-toggle">
                            <span class="mark-current-label">In Progress</span>
                            <label class="toggle-switch">
                                <input type="checkbox"
                                       ${stagedFile.isCurrent ? 'checked' : ''}
                                       onchange="updateStagedFile('${stagedFile.id}', 'isCurrent', this.checked)"
                                       ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="staged-file-content">
                        <div class="staged-file-info">
                            <div class="staged-file-name">${escapeHtml(stagedFile.file.name)}</div>
                            <div class="staged-file-size">${fileSize} MB</div>
                        </div>
                        <div class="staged-file-form">
                            <div class="staged-file-form-row">
                                <div class="form-group">
                                    <label>Name <span class="required">required</span></label>
                                    <input type="text"
                                           value="${escapeHtml(stagedFile.name)}"
                                           oninput="updateStagedFile('${stagedFile.id}', 'name', this.value)"
                                           ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>
                                </div>
                                <div class="form-group">
                                    <label>Category <span class="required">required</span></label>
                                    ${createCategoryDropdown(`staged-${stagedFile.id}`, stagedFile.category, isUploading || stagedFile.status === 'success')}
                                </div>
                            </div>
                            <div class="form-group">
                                <label>Description <span class="char-counter"><span id="desc-count-${stagedFile.id}">${(stagedFile.description || '').length}</span>/45</span></label>
                                <input type="text"
                                          maxlength="45"
                                          value="${escapeHtml(stagedFile.description)}"
                                          oninput="document.getElementById('desc-count-${stagedFile.id}').textContent = this.value.length; updateStagedFile('${stagedFile.id}', 'description', this.value)"
                                          ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="staged-file-hashtags">
                    <label>Hashtags</label>
                    ${createHashtagSelector(`staged-${stagedFile.id}`, stagedFile.hashtagIds || [], isUploading || stagedFile.status === 'success')}
                </div>

                ${showProgress ? `
                    <div class="upload-progress">
                        <div class="upload-progress-bar-container">
                            <div class="upload-progress-bar" style="width: ${stagedFile.progress}%"></div>
                        </div>
                        <div class="upload-progress-text">
                            <span>Progress</span>
                            <span>${stagedFile.progress}%</span>
                        </div>
                    </div>
                ` : ''}

                ${statusHTML}
            </div>
        `;
    }).join('');

    // Add event listeners for category dropdowns
    stagedFiles.forEach(stagedFile => {
        const dropdown = document.querySelector(`.category-dropdown[data-id="staged-${stagedFile.id}"]`);
        if (dropdown) {
            dropdown.addEventListener('categorychange', (e) => {
                updateStagedFile(stagedFile.id, 'category', e.detail.value);
            });
        }
    });

    updateStagedCount();
}

function updateStagedFile(fileId, field, value) {
    const stagedFile = stagedFiles.find(f => f.id === fileId);
    if (stagedFile) {
        console.log(`Updating staged file ${fileId}: ${field} = "${value}"`);
        stagedFile[field] = value;
        console.log('Updated stagedFile:', stagedFile);
    }
}

function removeStagedFile(fileId) {
    stagedFiles = stagedFiles.filter(f => f.id !== fileId);
    if (stagedFiles.length === 0) {
        hideStagingArea();
    } else {
        renderStagedFiles();
    }
}

function clearAllStaged(btn) {
    // Only clear staged and error files, not uploading or success
    const canClear = stagedFiles.filter(f => f.status === 'staged' || f.status === 'error');
    if (canClear.length === 0) {
        return;
    }

    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm';
        return;
    }

    // Second click - clear
    btn.classList.remove('confirm-delete');
    btn.textContent = 'Clear All';
    stagedFiles = stagedFiles.filter(f => f.status === 'uploading' || f.status === 'success');
    if (stagedFiles.length === 0) {
        hideStagingArea();
    } else {
        renderStagedFiles();
    }
}

function renderCompletedUploads(newUpload = null) {
    const container = document.getElementById('completed-uploads');
    const list = document.getElementById('completed-uploads-list');

    if (!container || !list) return;

    if (completedUploads.length === 0) {
        container.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    container.style.display = 'block';

    // If we have a new upload, just append it instead of re-rendering everything
    if (newUpload) {
        const thumbSrc = `${API_URL}/api/patterns/${newUpload.id}/thumbnail`;
        const itemHtml = `
            <div class="completed-upload-item" onclick="openPDFViewer(${newUpload.id})" title="${escapeHtml(newUpload.name)}">
                <img src="${thumbSrc}" alt="${escapeHtml(newUpload.name)}" class="completed-upload-thumb">
                <span class="completed-upload-name">${escapeHtml(newUpload.name)}</span>
            </div>
        `;
        list.insertAdjacentHTML('beforeend', itemHtml);
        return;
    }

    // Full re-render (only used when clearing or initial load)
    list.innerHTML = completedUploads.map(upload => {
        const thumbSrc = `${API_URL}/api/patterns/${upload.id}/thumbnail`;
        return `
            <div class="completed-upload-item" onclick="openPDFViewer(${upload.id})" title="${escapeHtml(upload.name)}">
                <img src="${thumbSrc}" alt="${escapeHtml(upload.name)}" class="completed-upload-thumb">
                <span class="completed-upload-name">${escapeHtml(upload.name)}</span>
            </div>
        `;
    }).join('');
}

function clearCompletedUploads(btn) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm';
        return;
    }

    // Second click - clear
    btn.classList.remove('confirm-delete');
    btn.textContent = 'Clear';
    completedUploads = [];
    renderCompletedUploads();
}

async function uploadAllPatterns() {
    const filesToUpload = stagedFiles.filter(f => f.status === 'staged' || f.status === 'error');

    if (filesToUpload.length === 0) {
        return;
    }

    // Upload files sequentially with progress tracking
    for (const stagedFile of filesToUpload) {
        await uploadStagedFile(stagedFile);
    }

    // Remove successful uploads from staging BEFORE reloading (to avoid flicker from loadCategories)
    stagedFiles = stagedFiles.filter(f => f.status !== 'success');

    // Reload patterns and categories after all uploads
    await loadPatterns();
    await loadCurrentPatterns();
    await loadCategories();

    // Update UI
    if (stagedFiles.length === 0 && completedUploads.length === 0) {
        hideStagingArea();
    } else {
        renderStagedFiles();
        updateStagedCount();
    }
}

async function uploadStagedFile(stagedFile) {
    stagedFile.status = 'uploading';
    stagedFile.progress = 0;
    stagedFile.error = null;

    // Get current hashtag selections before rendering (which might reset them)
    const hashtagIds = getSelectedHashtagIds(`staged-${stagedFile.id}`);
    stagedFile.hashtagIds = hashtagIds;

    renderStagedFiles();

    // If this is an overwrite, delete the existing pattern first
    if (stagedFile.overwritePatternId) {
        try {
            await fetch(`${API_URL}/api/patterns/${stagedFile.overwritePatternId}`, {
                method: 'DELETE'
            });
        } catch (err) {
            console.error('Error deleting pattern for overwrite:', err);
            // Continue with upload anyway
        }
    }

    const formData = new FormData();
    formData.append('pdf', stagedFile.file);
    formData.append('name', stagedFile.name || stagedFile.file.name.replace('.pdf', ''));
    formData.append('category', stagedFile.category);
    formData.append('description', stagedFile.description);
    formData.append('isCurrent', stagedFile.isCurrent);

    try {
        const xhr = new XMLHttpRequest();

        // Track upload progress - update only the progress bar to avoid flickering
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = (e.loaded / e.total) * 100;
                stagedFile.progress = Math.round(percentComplete);
                updateUploadProgress(stagedFile.id, stagedFile.progress);
            }
        });

        // Handle completion
        const uploadPromise = new Promise((resolve, reject) => {
            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.response));
                    } catch {
                        resolve(xhr.response);
                    }
                } else {
                    reject(new Error(xhr.statusText));
                }
            });
            xhr.addEventListener('error', () => reject(new Error('Network error')));
            xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
        });

        xhr.open('POST', `${API_URL}/api/patterns`);
        xhr.send(formData);

        const result = await uploadPromise;

        // Save hashtags if any were selected
        if (result && result.id && hashtagIds.length > 0) {
            await fetch(`${API_URL}/api/patterns/${result.id}/hashtags`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hashtagIds })
            });
        }

        stagedFile.status = 'success';
        stagedFile.progress = 100;

        // Store completed upload info for display
        if (result && result.id) {
            const newUpload = {
                id: result.id,
                name: result.name || stagedFile.name,
                thumbnail: result.thumbnail
            };
            completedUploads.push(newUpload);
            renderCompletedUploads(newUpload);
        }

        // Don't re-render staged files here - uploadAllPatterns will handle cleanup

    } catch (error) {
        console.error('Error uploading pattern:', error);
        stagedFile.status = 'error';
        stagedFile.error = error.message || 'Upload failed';
        renderStagedFiles();
    }
}

// Load patterns
async function loadPatterns() {
    try {
        const response = await fetch(`${API_URL}/api/patterns`);
        patterns = await response.json();
        patternsLoaded = true;
        displayPatterns();
        updateTabCounts();
        updateOwnerFilterSelect();
    } catch (error) {
        console.error('Error loading patterns:', error);
    }
}

function updateOwnerFilterSelect() {
    const select = document.getElementById('owner-filter-select');
    if (!select || currentUser?.role !== 'admin') return;

    // Build unique owners from patterns
    const owners = new Map();
    patterns.forEach(p => {
        if (p.user_id && !owners.has(p.user_id)) {
            owners.set(p.user_id, p.owner_display_name || p.owner_username || `User ${p.user_id}`);
        }
    });

    const currentSelection = select.value || ownerFilter;
    select.innerHTML = '<option value="all">All Users</option><option value="mine">Mine</option>' +
        Array.from(owners.entries())
            .filter(([id]) => id !== currentUser.id)
            .map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`)
            .join('');

    // Restore selection
    if (Array.from(select.options).some(opt => opt.value === currentSelection)) {
        select.value = currentSelection;
    } else {
        select.value = 'all';
        ownerFilter = 'all';
    }
}

async function loadCurrentPatterns() {
    try {
        const response = await fetch(`${API_URL}/api/patterns/current`);
        currentPatterns = await response.json();
        displayCurrentPatterns();
        updateTabCounts();
    } catch (error) {
        console.error('Error loading current patterns:', error);
    }
}

async function loadCategories() {
    try {
        // Load all possible categories for editing/uploading
        const allResponse = await fetch(`${API_URL}/api/categories/all`);
        allCategories = await allResponse.json();

        // Load populated categories with counts for filtering
        const populatedResponse = await fetch(`${API_URL}/api/categories`);
        populatedCategories = await populatedResponse.json();

        updateCategorySelects();
        renderCategoriesList();

        // Re-render staged files if any exist to populate category dropdowns
        if (stagedFiles.length > 0) {
            renderStagedFiles();
        }
    } catch (error) {
        console.error('Error loading categories:', error);
        // Fallback to default categories if API fails
        allCategories = ['Amigurumi', 'Wearables', 'Tunisian', 'Lace / Filet', 'Colorwork', 'Freeform', 'Micro', 'Other'];
        populatedCategories = [];
        updateCategorySelects();
        renderCategoriesList();
    }
}

async function loadHashtags() {
    try {
        const response = await fetch(`${API_URL}/api/hashtags`);
        allHashtags = await response.json();
        // Sort hashtags alphabetically
        allHashtags.sort((a, b) => a.name.localeCompare(b.name));
        renderHashtagsList();

        // Re-render staged files if any exist to populate hashtag selectors
        if (stagedFiles.length > 0) {
            renderStagedFiles();
        }
    } catch (error) {
        console.error('Error loading hashtags:', error);
        allHashtags = [];
        renderHashtagsList();
    }
}

function createCategoryDropdown(id, selectedCategory, disabled = false) {
    const selected = selectedCategory || getDefaultCategory();
    return `
        <div class="category-dropdown ${disabled ? 'disabled' : ''}" data-id="${id}" data-value="${escapeHtml(selected)}">
            <div class="category-dropdown-selected" onclick="toggleCategoryDropdown('${id}')">
                <span class="category-dropdown-value">${escapeHtml(selected)}</span>
                <span class="category-dropdown-arrow">▼</span>
            </div>
            <div class="category-dropdown-menu" id="category-menu-${id}">
                ${allCategories.map(cat => `
                    <div class="category-dropdown-item ${cat === selected ? 'selected' : ''}"
                         onclick="selectCategory('${id}', '${escapeHtml(cat)}')">
                        ${escapeHtml(cat)}
                    </div>
                `).join('')}
                <div class="category-dropdown-add">
                    <input type="text" placeholder="Add new"
                           onkeydown="handleNewCategoryKeydown(event, '${id}')"
                           onclick="event.stopPropagation()">
                </div>
            </div>
        </div>
    `;
}

function toggleCategoryDropdown(id) {
    const dropdown = document.querySelector(`.category-dropdown[data-id="${id}"]`);
    if (dropdown.classList.contains('disabled')) return;

    // Close all other dropdowns
    document.querySelectorAll('.category-dropdown.open').forEach(d => {
        if (d.dataset.id !== id) d.classList.remove('open');
    });

    dropdown.classList.toggle('open');

    if (dropdown.classList.contains('open')) {
        const input = dropdown.querySelector('.category-dropdown-add input');
        if (input) input.value = '';
    }
}

function selectCategory(id, value) {
    const dropdown = document.querySelector(`.category-dropdown[data-id="${id}"]`);
    dropdown.dataset.value = value;
    dropdown.querySelector('.category-dropdown-value').textContent = value;
    dropdown.classList.remove('open');

    // Update selected state
    dropdown.querySelectorAll('.category-dropdown-item').forEach(item => {
        item.classList.toggle('selected', item.textContent.trim() === value);
    });

    // Handle project staged file category updates
    if (id.startsWith('project-staged-')) {
        const fileId = id.replace('project-staged-', '');
        updateProjectStagedFileCategory(fileId, value);
    }

    // Trigger the callback
    const event = new CustomEvent('categorychange', { detail: { id, value } });
    dropdown.dispatchEvent(event);
}

async function handleNewCategoryKeydown(event, dropdownId) {
    if (event.key === 'Enter') {
        event.preventDefault();
        const input = event.target;
        const name = input.value.trim();

        if (!name) return;

        try {
            const response = await fetch(`${API_URL}/api/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to add category');
            }

            await loadCategories();
            selectCategory(dropdownId, name);
        } catch (error) {
            alert(error.message);
        }
    } else if (event.key === 'Escape') {
        const dropdown = document.querySelector(`.category-dropdown[data-id="${dropdownId}"]`);
        dropdown.classList.remove('open');
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.category-dropdown')) {
        document.querySelectorAll('.category-dropdown.open').forEach(d => d.classList.remove('open'));
    }
});

function getCategoryDropdownValue(id) {
    const dropdown = document.querySelector(`.category-dropdown[data-id="${id}"]`);
    return dropdown ? dropdown.dataset.value : '';
}

function updateCategorySelects() {
    // Update library filter select - use POPULATED categories (with counts)
    const filterSelect = document.getElementById('category-filter-select');
    if (filterSelect) {
        // Save current selection before rebuilding dropdown
        const currentSelection = filterSelect.value || selectedCategoryFilter;

        const totalCount = populatedCategories.reduce((sum, cat) => sum + cat.count, 0);
        filterSelect.innerHTML = `<option value="all">All Categories (${totalCount})</option>` +
            populatedCategories.map(cat =>
                `<option value="${escapeHtml(cat.name)}">${escapeHtml(cat.name)} (${cat.count})</option>`
            ).join('');

        // Restore previous selection if it still exists in the dropdown
        if (currentSelection && Array.from(filterSelect.options).some(opt => opt.value === currentSelection)) {
            filterSelect.value = currentSelection;
            selectedCategoryFilter = currentSelection;
        } else {
            // If selected category no longer exists (e.g., it was the last pattern in that category), switch to "all"
            filterSelect.value = 'all';
            selectedCategoryFilter = 'all';
            displayPatterns();
        }

        // Add event listener for filter
        filterSelect.removeEventListener('change', handleCategoryFilter);
        filterSelect.addEventListener('change', handleCategoryFilter);
    }
}

function handleCategoryFilter(e) {
    selectedCategoryFilter = e.target.value;
    localStorage.setItem('libraryCategoryFilter', selectedCategoryFilter);
    displayPatterns();
}

// Settings page
function initSettings() {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsBackBtn = document.getElementById('settings-back-btn');
    const addCategoryBtn = document.getElementById('add-category-btn');
    const newCategoryInput = document.getElementById('new-category-input');
    const tabCountsCheckbox = document.getElementById('tab-counts-checkbox');

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            // If already in settings, go back; otherwise go to settings
            const settingsTab = document.getElementById('settings');
            if (settingsTab && settingsTab.classList.contains('active')) {
                navigateBack();
            } else {
                switchToTab('settings');
                loadLibraryStats();
            }
        });
    }

    if (settingsBackBtn) {
        settingsBackBtn.addEventListener('click', () => {
            navigateBack();
        });
    }

    if (tabCountsCheckbox) {
        tabCountsCheckbox.checked = showTabCounts;
        tabCountsCheckbox.addEventListener('change', () => {
            showTabCounts = tabCountsCheckbox.checked;
            localStorage.setItem('showTabCounts', showTabCounts);
            updateTabCounts();
            showToast(showTabCounts ? 'Tab counts shown' : 'Tab counts hidden');
        });
    }

    const showInventoryCheckbox = document.getElementById('show-inventory-checkbox');
    if (showInventoryCheckbox) {
        showInventoryCheckbox.checked = showInventoryTab;
        showInventoryCheckbox.addEventListener('change', () => {
            showInventoryTab = showInventoryCheckbox.checked;
            localStorage.setItem('showInventoryTab', showInventoryTab);
            applyInventoryTabVisibility();
            showToast(showInventoryTab ? 'Inventory tab shown' : 'Inventory tab hidden');
        });
    }

    // Default page setting
    const defaultPageSelect = document.getElementById('default-page-select');
    if (defaultPageSelect) {
        const savedDefaultPage = localStorage.getItem('defaultPage') || 'current';
        defaultPageSelect.value = savedDefaultPage;
        defaultPageSelect.addEventListener('change', () => {
            localStorage.setItem('defaultPage', defaultPageSelect.value);
            showToast('Default page updated');
        });
    }

    // PDF scroll mode setting
    const pdfScrollModeSelect = document.getElementById('pdf-scroll-mode-select');
    const scrollPageButtonsContainer = document.getElementById('scroll-page-buttons-container');
    const scrollPageButtonsCheckbox = document.getElementById('scroll-page-buttons-checkbox');
    if (pdfScrollModeSelect) {
        pdfScrollModeSelect.value = localStorage.getItem('pdfScrollMode') || 'scroll';
        // Show page buttons toggle only when in scroll mode
        if (scrollPageButtonsContainer) {
            scrollPageButtonsContainer.style.display = pdfScrollModeSelect.value === 'scroll' ? '' : 'none';
        }
        pdfScrollModeSelect.addEventListener('change', () => {
            localStorage.setItem('pdfScrollMode', pdfScrollModeSelect.value);
            showToast(pdfScrollModeSelect.value === 'page' ? 'Paginated mode' : 'Scroll mode');
            if (scrollPageButtonsContainer) {
                scrollPageButtonsContainer.style.display = pdfScrollModeSelect.value === 'scroll' ? '' : 'none';
            }
        });
    }
    if (scrollPageButtonsCheckbox) {
        scrollPageButtonsCheckbox.checked = localStorage.getItem('scrollPageButtons') === 'true';
        scrollPageButtonsCheckbox.addEventListener('change', () => {
            localStorage.setItem('scrollPageButtons', scrollPageButtonsCheckbox.checked);
            const earlyHide = document.getElementById('early-hide-page-btns');
            if (earlyHide) earlyHide.remove();
            showToast(scrollPageButtonsCheckbox.checked ? 'Page buttons shown' : 'Page buttons hidden');
        });
    }

    // Default zoom setting
    const defaultZoomSelect = document.getElementById('default-zoom-select');
    if (defaultZoomSelect) {
        const savedDefaultZoom = localStorage.getItem('defaultPdfZoom') || 'fit';
        defaultZoomSelect.value = savedDefaultZoom;
        defaultZoomSelect.addEventListener('change', () => {
            localStorage.setItem('defaultPdfZoom', defaultZoomSelect.value);
            showToast('Default zoom updated');
        });
    }

    // Auto-current on timer setting
    const autoCurrentTimerCheckbox = document.getElementById('auto-current-timer-checkbox');
    if (autoCurrentTimerCheckbox) {
        autoCurrentTimerCheckbox.checked = autoCurrentOnTimer;
        autoCurrentTimerCheckbox.addEventListener('change', () => {
            autoCurrentOnTimer = autoCurrentTimerCheckbox.checked;
            localStorage.setItem('autoCurrentOnTimer', autoCurrentOnTimer);
            showToast(autoCurrentOnTimer ? 'Patterns will be marked in progress on timer start' : 'Auto in-progress disabled');
        });
    }

    // Auto timer default setting
    const autoTimerDefaultCheckbox = document.getElementById('auto-timer-default-checkbox');
    if (autoTimerDefaultCheckbox) {
        autoTimerDefaultCheckbox.checked = autoTimerDefault;
        autoTimerDefaultCheckbox.addEventListener('change', () => {
            autoTimerDefault = autoTimerDefaultCheckbox.checked;
            localStorage.setItem('autoTimerDefault', autoTimerDefault);
            showToast(autoTimerDefault ? 'Auto timer will be enabled by default' : 'Auto timer disabled by default');
        });
    }

    // Inactivity timeout setting
    const inactivityTimeoutInput = document.getElementById('inactivity-timeout-input');
    if (inactivityTimeoutInput) {
        const savedTimeout = localStorage.getItem('inactivityTimeout') || '5';
        inactivityTimeoutInput.value = savedTimeout;

        const applyInactivityTimeout = () => {
            const minutes = Math.max(0, Math.floor(parseInt(inactivityTimeoutInput.value, 10) || 0));
            inactivityTimeoutInput.value = minutes;
            localStorage.setItem('inactivityTimeout', minutes);
            inactivityDelay = minutes * 60 * 1000;
            showToast(minutes === 0 ? 'Auto timer will never pause' : `Auto timer will pause after ${minutes} minute${minutes === 1 ? '' : 's'}`);
        };
        inactivityTimeoutInput.addEventListener('change', applyInactivityTimeout);
        inactivityTimeoutInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                inactivityTimeoutInput.blur();
            }
        });
    }

    // Badge visibility settings
    const badgeTypeCheckbox = document.getElementById('badge-type-checkbox');
    const badgeStatusCheckbox = document.getElementById('badge-status-checkbox');
    const badgeCategoryCheckbox = document.getElementById('badge-category-checkbox');
    const badgeStarCheckbox = document.getElementById('badge-star-checkbox');

    if (badgeTypeCheckbox) {
        badgeTypeCheckbox.checked = showTypeBadge;
        badgeTypeCheckbox.addEventListener('change', () => {
            showTypeBadge = badgeTypeCheckbox.checked;
            localStorage.setItem('showTypeBadge', showTypeBadge);
            displayPatterns();
            displayCurrentPatterns();
            showToast(showTypeBadge ? 'Type badge shown' : 'Type badge hidden');
        });
    }

    if (badgeStatusCheckbox) {
        badgeStatusCheckbox.checked = showStatusBadge;
        badgeStatusCheckbox.addEventListener('change', () => {
            showStatusBadge = badgeStatusCheckbox.checked;
            localStorage.setItem('showStatusBadge', showStatusBadge);
            displayPatterns();
            displayCurrentPatterns();
            showToast(showStatusBadge ? 'Status badge shown' : 'Status badge hidden');
        });
    }

    if (badgeCategoryCheckbox) {
        badgeCategoryCheckbox.checked = showCategoryBadge;
        badgeCategoryCheckbox.addEventListener('change', () => {
            showCategoryBadge = badgeCategoryCheckbox.checked;
            localStorage.setItem('showCategoryBadge', showCategoryBadge);
            displayPatterns();
            displayCurrentPatterns();
            showToast(showCategoryBadge ? 'Category badge shown' : 'Category badge hidden');
        });
    }

    if (badgeStarCheckbox) {
        badgeStarCheckbox.checked = showStarBadge;
        badgeStarCheckbox.addEventListener('change', () => {
            showStarBadge = badgeStarCheckbox.checked;
            localStorage.setItem('showStarBadge', showStarBadge);
            displayPatterns();
            displayCurrentPatterns();
            showToast(showStarBadge ? 'Favorite badge shown' : 'Favorite badge hidden');
        });
    }

    const badgeRatingCheckbox = document.getElementById('badge-rating-checkbox');
    if (badgeRatingCheckbox) {
        badgeRatingCheckbox.checked = showRatingBadge;
        badgeRatingCheckbox.addEventListener('change', () => {
            showRatingBadge = badgeRatingCheckbox.checked;
            localStorage.setItem('showRatingBadge', showRatingBadge);
            displayPatterns();
            displayCurrentPatterns();
            showToast(showRatingBadge ? 'Rating badge shown' : 'Rating badge hidden');
        });
    }

    if (addCategoryBtn) {
        addCategoryBtn.addEventListener('click', addCategory);
    }

    if (newCategoryInput) {
        newCategoryInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                addCategory();
            }
        });
    }

    const addHashtagBtn = document.getElementById('add-hashtag-btn');
    const newHashtagInput = document.getElementById('new-hashtag-input');

    if (addHashtagBtn) {
        addHashtagBtn.addEventListener('click', addHashtag);
    }

    if (newHashtagInput) {
        newHashtagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                addHashtag();
            }
        });
    }

    // Keyboard Shortcuts
    initKeyboardShortcuts();

    // Mobile bar (top + bottom bars for PDF viewer)
    mobileBar.init();

    // Notifications Section
    initNotificationsSection();

    // Settings sidebar navigation
    const settingsNavBtns = document.querySelectorAll('.settings-nav-btn');
    const settingsSections = document.querySelectorAll('.settings-content .settings-section');

    settingsNavBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            btn.blur();
            // Clear search when clicking nav
            clearSettingsSearch();
            switchToSettingsSection(section, true);
        });
    });

    // Settings search functionality
    initSettingsSearch();

    // Swipe between settings sections on mobile
    if (window.matchMedia('(max-width: 768px)').matches) {
        const settingsContent = document.querySelector('.settings-content');
        if (settingsContent) {
            let startX = 0, startY = 0, tracking = false;

            settingsContent.addEventListener('touchstart', (e) => {
                if (e.target.closest('.toggle-switch, select, input, button, .toggle-slider')) return;
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                tracking = true;
            }, { passive: true });

            settingsContent.addEventListener('touchend', (e) => {
                if (!tracking) return;
                tracking = false;

                const diffX = e.changedTouches[0].clientX - startX;
                const diffY = e.changedTouches[0].clientY - startY;
                if (Math.abs(diffX) < 80 || Math.abs(diffY) > Math.abs(diffX)) return;

                const visibleBtns = [...document.querySelectorAll('.settings-nav-btn')].filter(b => b.style.display !== 'none');
                const activeBtn = document.querySelector('.settings-nav-btn.active');
                const currentIdx = visibleBtns.indexOf(activeBtn);
                if (currentIdx === -1) return;

                const nextIdx = diffX < 0 ? currentIdx + 1 : currentIdx - 1;
                if (nextIdx >= 0 && nextIdx < visibleBtns.length) {
                    switchToSettingsSection(visibleBtns[nextIdx].dataset.section, true);
                }
            }, { passive: true });
        }
    }
}

function initSettingsSearch() {
    const searchInput = document.getElementById('settings-search-input');
    const clearBtn = document.getElementById('settings-search-clear');
    const noResults = document.getElementById('settings-no-results');

    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        // Show/hide clear button
        if (clearBtn) {
            clearBtn.classList.toggle('visible', query.length > 0);
        }

        if (query.length === 0) {
            clearSettingsSearch();
            return;
        }

        filterSettings(query);
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            searchInput.value = '';
            clearBtn.classList.remove('visible');
            clearSettingsSearch();
            // On mobile, collapse the search bar
            const wrapper = document.querySelector('.settings-search-wrapper');
            if (wrapper && window.matchMedia('(max-width: 768px)').matches) {
                wrapper.classList.remove('expanded');
            } else {
                searchInput.focus();
            }
        });
    }

    // Mobile: tap search wrapper to expand, tap outside to collapse
    const searchWrapper = document.querySelector('.settings-search-wrapper');
    if (searchWrapper) {
        searchWrapper.addEventListener('click', (e) => {
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            if (searchWrapper.classList.contains('expanded')) return;
            searchWrapper.classList.add('expanded');
            searchInput.focus();
        });

        document.addEventListener('click', (e) => {
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            if (!searchWrapper.contains(e.target) && searchWrapper.classList.contains('expanded')) {
                if (!searchInput.value) {
                    searchWrapper.classList.remove('expanded');
                }
            }
        });
    }
}

function filterSettings(query) {
    const sections = document.querySelectorAll('.settings-content .settings-section');
    const noResults = document.getElementById('settings-no-results');
    const navBtns = document.querySelectorAll('.settings-nav-btn');
    let totalMatches = 0;

    // Hide nav buttons during search
    navBtns.forEach(btn => btn.style.display = 'none');

    sections.forEach(section => {
        const items = section.querySelectorAll('.setting-item');
        const subheadings = section.querySelectorAll('.settings-subheading');
        let sectionMatches = 0;

        // Check each setting item
        items.forEach(item => {
            const label = item.querySelector('label')?.textContent?.toLowerCase() || '';
            const description = item.querySelector('.setting-description')?.textContent?.toLowerCase() || '';
            const matches = label.includes(query) || description.includes(query);

            item.classList.toggle('search-hidden', !matches);
            if (matches) sectionMatches++;
        });

        // Check section title and description
        const sectionTitle = section.querySelector('h3')?.textContent?.toLowerCase() || '';
        const sectionDesc = section.querySelector('.section-description')?.textContent?.toLowerCase() || '';
        const sectionHeaderMatches = sectionTitle.includes(query) || sectionDesc.includes(query);

        // If section header matches, show all items in that section
        if (sectionHeaderMatches) {
            items.forEach(item => item.classList.remove('search-hidden'));
            sectionMatches = items.length;
        }

        // Show/hide subheadings based on whether they have visible items after them
        subheadings.forEach(heading => {
            let hasVisibleItems = false;
            let sibling = heading.nextElementSibling;
            while (sibling && !sibling.classList.contains('settings-subheading') && sibling.tagName !== 'H4') {
                if (sibling.classList.contains('setting-item') && !sibling.classList.contains('search-hidden')) {
                    hasVisibleItems = true;
                    break;
                }
                sibling = sibling.nextElementSibling;
            }
            heading.classList.toggle('search-hidden', !hasVisibleItems);
        });

        // Show/hide entire section
        section.classList.toggle('search-hidden', sectionMatches === 0);
        section.classList.toggle('active', sectionMatches > 0);

        totalMatches += sectionMatches;
    });

    // Show/hide no results message
    if (noResults) {
        noResults.classList.toggle('visible', totalMatches === 0);
    }
}

function clearSettingsSearch() {
    const sections = document.querySelectorAll('.settings-content .settings-section');
    const noResults = document.getElementById('settings-no-results');
    const navBtns = document.querySelectorAll('.settings-nav-btn');
    const searchInput = document.getElementById('settings-search-input');
    const clearBtn = document.getElementById('settings-search-clear');

    // Clear input
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.classList.remove('visible');

    // Show nav buttons
    navBtns.forEach(btn => btn.style.display = '');

    // Remove all search-hidden classes
    sections.forEach(section => {
        section.classList.remove('search-hidden');
        section.querySelectorAll('.setting-item').forEach(item => item.classList.remove('search-hidden'));
        section.querySelectorAll('.settings-subheading').forEach(heading => heading.classList.remove('search-hidden'));
    });

    // Hide no results
    if (noResults) noResults.classList.remove('visible');

    // Restore active section based on nav
    const activeNav = document.querySelector('.settings-nav-btn.active');
    if (activeNav) {
        const activeSection = activeNav.dataset.section;
        sections.forEach(s => s.classList.toggle('active', s.dataset.section === activeSection));
    }
}

// Switch to a specific settings section
function switchToSettingsSection(section, updateHistory = true) {
    const settingsNavBtns = document.querySelectorAll('.settings-nav-btn');
    const settingsSections = document.querySelectorAll('.settings-content .settings-section');

    // Update active nav button
    settingsNavBtns.forEach(b => {
        if (b.dataset.section === section) {
            b.classList.add('active');
            b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        } else {
            b.classList.remove('active');
        }
    });

    // Show corresponding section
    settingsSections.forEach(s => {
        if (s.dataset.section === section) {
            s.classList.add('active');
        } else {
            s.classList.remove('active');
        }
    });

    // Reset scroll position when switching sections
    const settingsContent = document.querySelector('.settings-content');
    if (settingsContent) {
        settingsContent.scrollTop = 0;
    }

    // Update URL hash
    if (updateHistory) {
        history.pushState({ view: `settings/${section}` }, '', `#settings/${section}`);
    }

    // Initialize section-specific content
    if (section === 'account') {
        loadAccountInfo();
    } else if (section === 'ravelry') {
        initRavelryTab();
    } else if (section === 'archive') {
        loadArchiveSettings();
    } else if (section === 'about') {
        loadLibraryStats();
    }
}


// Archive section initialization
async function loadArchiveSettings() {
    // Initialize enable delete toggle
    const enableDeleteCheckbox = document.getElementById('enable-delete-checkbox');
    const archiveSettingsSection = document.getElementById('archive-settings-section');
    const deleteModeWarning = document.getElementById('delete-mode-warning');
    const toggleSwitch = enableDeleteCheckbox?.closest('.toggle-switch');

    // Helper to update visibility based on delete mode
    function updateArchiveSectionVisibility(deleteEnabled) {
        if (archiveSettingsSection) {
            archiveSettingsSection.style.display = deleteEnabled ? 'none' : 'block';
        }
        const archivedPatternsSection = document.getElementById('archived-patterns-section');
        if (archivedPatternsSection) {
            archivedPatternsSection.style.display = deleteEnabled ? 'none' : 'block';
        }
    }

    // Helper to update warning visibility based on archived item count
    async function updateWarningVisibility() {
        if (!deleteModeWarning || enableDirectDelete) {
            if (deleteModeWarning) deleteModeWarning.style.display = 'none';
            return;
        }
        try {
            const [patResponse, projResponse] = await Promise.all([
                fetch(`${API_URL}/api/patterns/archived`),
                fetch(`${API_URL}/api/projects/archived`)
            ]);
            const archivedPatterns = await patResponse.json();
            const archivedProjects = await projResponse.json();
            deleteModeWarning.style.display = (archivedPatterns.length + archivedProjects.length) > 0 ? 'block' : 'none';
        } catch (error) {
            deleteModeWarning.style.display = 'none';
        }
    }

    // Reset confirmation state
    function resetConfirmState() {
        if (toggleSwitch) {
            toggleSwitch.removeAttribute('data-pending-confirm');
            toggleSwitch.classList.remove('confirm-state');
            toggleSwitch.title = '';
        }
    }

    // Check if pending confirmation
    function isPendingConfirm() {
        return toggleSwitch?.hasAttribute('data-pending-confirm');
    }

    // Set pending confirmation
    function setPendingConfirm() {
        if (toggleSwitch) {
            toggleSwitch.setAttribute('data-pending-confirm', 'true');
        }
    }

    if (enableDeleteCheckbox && !enableDeleteCheckbox.hasAttribute('data-initialized')) {
        enableDeleteCheckbox.setAttribute('data-initialized', 'true');
        enableDeleteCheckbox.checked = enableDirectDelete;
        updateArchiveSectionVisibility(enableDirectDelete);
        updateWarningVisibility();

        enableDeleteCheckbox.addEventListener('change', async (e) => {
            const turningOn = enableDeleteCheckbox.checked;
            const pending = isPendingConfirm();
            console.log('Toggle change:', { turningOn, pending });

            // If confirming deletion (check this FIRST before the async call resets state)
            if (turningOn && pending) {
                console.log('Confirming deletion');
                // Delete all archived patterns and projects
                try {
                    await fetch(`${API_URL}/api/patterns/archived/all`, { method: 'DELETE' });
                    showToast('Archived patterns and projects deleted');
                    await loadArchivedPatternsUI();
                } catch (error) {
                    console.error('Error deleting archived items:', error);
                }
                resetConfirmState();
                // Continue to enable delete mode below
            }
            // If turning ON and there are archived items, require confirmation
            else if (turningOn && !pending) {
                console.log('First click - checking for archived items');
                try {
                    const [patResponse, projResponse] = await Promise.all([
                        fetch(`${API_URL}/api/patterns/archived`),
                        fetch(`${API_URL}/api/projects/archived`)
                    ]);
                    const archivedPatterns = await patResponse.json();
                    const archivedProjects = await projResponse.json();
                    const totalCount = archivedPatterns.length + archivedProjects.length;

                    if (totalCount > 0) {
                        const parts = [];
                        if (archivedPatterns.length > 0) parts.push(`${archivedPatterns.length} pattern${archivedPatterns.length !== 1 ? 's' : ''}`);
                        if (archivedProjects.length > 0) parts.push(`${archivedProjects.length} project${archivedProjects.length !== 1 ? 's' : ''}`);
                        const label = parts.join(' and ');
                        enableDeleteCheckbox.checked = false;
                        setPendingConfirm();
                        if (toggleSwitch) {
                            toggleSwitch.classList.add('confirm-state');
                            toggleSwitch.title = `Click again to delete ${label} and enable`;
                        }
                        showToast(`Click again to delete ${label}`);
                        return;
                    }
                } catch (error) {
                    console.error('Error checking archived items:', error);
                }
            }

            enableDirectDelete = enableDeleteCheckbox.checked;
            localStorage.setItem('enableDirectDelete', enableDirectDelete);
            updateArchiveSectionVisibility(enableDirectDelete);
            updateWarningVisibility();

            if (!turningOn) {
                resetConfirmState();
                showToast('Archive mode enabled');
            } else {
                showToast('Direct delete enabled');
            }

            // Re-render pattern cards to update button icons
            displayPatterns();
            displayCurrentPatterns();
        });

        // Reset confirm state if user clicks elsewhere (with delay to allow change event to fire first)
        document.addEventListener('click', (e) => {
            if (isPendingConfirm() && !toggleSwitch?.contains(e.target)) {
                setTimeout(() => {
                    if (isPendingConfirm()) {
                        resetConfirmState();
                    }
                }, 100);
            }
        });
    }

    // Initialize auto-delete toggle
    const autoDeleteCheckbox = document.getElementById('auto-delete-checkbox');
    const autoDeleteDaysSetting = document.getElementById('auto-delete-days-setting');
    const autoDeleteDaysInput = document.getElementById('auto-delete-days');

    if (autoDeleteCheckbox && !autoDeleteCheckbox.hasAttribute('data-initialized')) {
        autoDeleteCheckbox.setAttribute('data-initialized', 'true');

        // Load settings from server first
        let autoDeleteEnabled = false;
        let autoDeleteDays = 30;
        try {
            const response = await fetch(`${API_URL}/api/settings/archive`);
            if (response.ok) {
                const serverSettings = await response.json();
                autoDeleteEnabled = serverSettings.autoDeleteEnabled || false;
                autoDeleteDays = serverSettings.autoDeleteDays || 30;
            }
        } catch (error) {
            console.error('Error loading archive settings from server:', error);
        }

        autoDeleteCheckbox.checked = autoDeleteEnabled;
        if (autoDeleteDaysInput) autoDeleteDaysInput.value = autoDeleteDays;
        if (autoDeleteDaysSetting) autoDeleteDaysSetting.style.display = autoDeleteEnabled ? 'flex' : 'none';

        autoDeleteCheckbox.addEventListener('change', () => {
            const enabled = autoDeleteCheckbox.checked;
            if (autoDeleteDaysSetting) autoDeleteDaysSetting.style.display = enabled ? 'flex' : 'none';
            saveAutoDeleteSettings();
            showToast(enabled ? 'Auto-delete enabled' : 'Auto-delete disabled');
        });
    }

    if (autoDeleteDaysInput && !autoDeleteDaysInput.hasAttribute('data-initialized')) {
        autoDeleteDaysInput.setAttribute('data-initialized', 'true');
        autoDeleteDaysInput.addEventListener('change', () => {
            let days = parseInt(autoDeleteDaysInput.value) || 30;
            days = Math.max(1, Math.min(365, days));
            autoDeleteDaysInput.value = days;
            saveAutoDeleteSettings();
        });
    }

    // Initialize delete all archived button
    const deleteAllBtn = document.getElementById('delete-all-archived-btn');
    if (deleteAllBtn && !deleteAllBtn.hasAttribute('data-initialized')) {
        deleteAllBtn.setAttribute('data-initialized', 'true');
        deleteAllBtn.addEventListener('click', () => handleDeleteAllArchived(deleteAllBtn));
    }

    // Load archived patterns list
    await loadArchivedPatternsUI();

    // Delete All archived projects button
    const deleteAllProjectsBtn = document.getElementById('delete-all-archived-projects-btn');
    if (deleteAllProjectsBtn) {
        deleteAllProjectsBtn.addEventListener('click', () => handleDeleteAllArchivedProjects(deleteAllProjectsBtn));
    }

    // Load archived projects list
    await loadArchivedProjectsUI();
}

// Save auto-delete settings to server
async function saveAutoDeleteSettings() {
    const autoDeleteCheckbox = document.getElementById('auto-delete-checkbox');
    const autoDeleteDaysInput = document.getElementById('auto-delete-days');

    const enabled = autoDeleteCheckbox ? autoDeleteCheckbox.checked : false;
    const days = autoDeleteDaysInput ? parseInt(autoDeleteDaysInput.value) || 30 : 30;

    try {
        await fetch(`${API_URL}/api/settings/archive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoDeleteEnabled: enabled, autoDeleteDays: days })
        });
    } catch (error) {
        console.error('Error saving auto-delete settings:', error);
    }
}

// Keyboard Shortcuts Functions
function matchesShortcut(key, shortcutName) {
    const shortcuts = keyboardShortcuts[shortcutName] || [];
    return shortcuts.includes(key);
}

function getKeyDisplayName(key) {
    if (!key) return '';
    const keyNames = {
        ' ': 'Space',
        'ArrowUp': '↑',
        'ArrowDown': '↓',
        'ArrowLeft': '←',
        'ArrowRight': '→',
        'Tab': 'Tab',
        'Enter': 'Enter',
        'Escape': 'Esc',
        'Backspace': '⌫',
        'Delete': 'Del',
        '+': '+',
        '-': '-',
        '=': '=',
        'MediaPlayPause': '⏯',
        'MediaTrackNext': '⏭',
        'MediaTrackPrevious': '⏮',
        'MediaStop': '⏹'
    };
    return keyNames[key] || key.toUpperCase();
}

function initKeyboardShortcuts() {
    const shortcutBtns = document.querySelectorAll('.shortcut-key-btn');
    const resetBtn = document.getElementById('reset-shortcuts-btn');
    let listeningBtn = null;

    // Update all shortcut button displays
    function updateShortcutDisplays() {
        shortcutBtns.forEach(btn => {
            const shortcutName = btn.dataset.shortcut;
            const index = parseInt(btn.dataset.index);
            const key = keyboardShortcuts[shortcutName]?.[index] || '';
            btn.textContent = getKeyDisplayName(key);
        });
    }

    // Initialize displays
    updateShortcutDisplays();

    // Click handler for shortcut buttons
    shortcutBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // If already listening on this button, cancel
            if (listeningBtn === btn) {
                btn.classList.remove('listening');
                listeningBtn = null;
                updateShortcutDisplays();
                return;
            }

            // Cancel any other listening button
            if (listeningBtn) {
                listeningBtn.classList.remove('listening');
                updateShortcutDisplays();
            }

            // Start listening on this button
            listeningBtn = btn;
            btn.classList.add('listening');
            btn.textContent = '...';
        });

        // Right-click to clear shortcut
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const shortcutName = btn.dataset.shortcut;
            const index = parseInt(btn.dataset.index);

            // Only clear if there's a shortcut set
            if (keyboardShortcuts[shortcutName]?.[index]) {
                keyboardShortcuts[shortcutName][index] = '';
                localStorage.setItem('keyboardShortcuts', JSON.stringify(keyboardShortcuts));
                updateShortcutDisplays();
                showToast('Shortcut cleared');
            }
        });
    });

    // Helper to save a captured key
    const captureKey = (key) => {
        if (!listeningBtn) return false;

        const shortcutName = listeningBtn.dataset.shortcut;
        const index = parseInt(listeningBtn.dataset.index);

        // Remove this key from any other shortcut to prevent conflicts
        for (const [name, keys] of Object.entries(keyboardShortcuts)) {
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] === key && !(name === shortcutName && i === index)) {
                    keyboardShortcuts[name][i] = '';
                }
            }
        }

        // Set the new shortcut
        keyboardShortcuts[shortcutName][index] = key;

        // Save to localStorage
        localStorage.setItem('keyboardShortcuts', JSON.stringify(keyboardShortcuts));

        // Update display and stop listening
        listeningBtn.classList.remove('listening');
        updateShortcutDisplays();
        listeningBtn = null;
        showToast('Shortcut updated');
        return true;
    };

    // Global keydown handler for capturing shortcuts
    document.addEventListener('keydown', (e) => {
        if (!listeningBtn) return;

        e.preventDefault();
        e.stopPropagation();

        captureKey(e.key);
    }, true);

    // Expose captureKey globally so media session handlers can use it
    window._yarnlCaptureMediaKey = captureKey;

    // Reset to defaults button
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            keyboardShortcuts = JSON.parse(JSON.stringify(defaultShortcuts));
            localStorage.setItem('keyboardShortcuts', JSON.stringify(keyboardShortcuts));
            updateShortcutDisplays();
            showToast('Shortcuts reset to defaults');
        });
    }
}

// Add Pattern Menu
function initAddMenu() {
    const addBtn = document.getElementById('add-pattern-btn');
    const addMenu = document.getElementById('add-menu');
    const uploadPdfBtn = document.getElementById('add-upload-pdf');
    const newPatternBtn = document.getElementById('add-new-pattern');
    const closeUploadPanel = document.getElementById('close-upload-panel');
    const closeNewPatternPanel = document.getElementById('close-new-pattern-panel');

    if (addBtn && addMenu) {
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = addMenu.style.display !== 'none';
            addMenu.style.display = isOpen ? 'none' : 'block';
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!addBtn.contains(e.target) && !addMenu.contains(e.target)) {
                addMenu.style.display = 'none';
            }
        });
    }

    if (uploadPdfBtn) {
        uploadPdfBtn.addEventListener('click', () => {
            addMenu.style.display = 'none';
            showUploadPanel();
        });
    }

    if (newPatternBtn) {
        newPatternBtn.addEventListener('click', () => {
            addMenu.style.display = 'none';
            showNewPatternPanel();
        });
    }

    const newProjectBtn = document.getElementById('add-new-project');
    if (newProjectBtn) {
        newProjectBtn.addEventListener('click', () => {
            addMenu.style.display = 'none';
            showNewProjectPanel();
        });
    }

    // Ravelry URL import
    const ravelryUrlBtn = document.getElementById('add-ravelry-url');

    function resetRavelryUrlModal() {
        const input = document.getElementById('ravelry-url-input');
        const status = document.getElementById('ravelry-url-status');
        const previewBtn = document.getElementById('preview-ravelry-url');
        const submitBtn = document.getElementById('submit-ravelry-url');
        const progressWrap = document.getElementById('ravelry-url-progress');
        if (input) { input.value = ''; }
        if (status) status.style.display = 'none';
        if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = 'Next'; }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Import'; }
        if (progressWrap) progressWrap.style.display = 'none';
        document.getElementById('ravelry-url-step1').style.display = '';
        document.getElementById('ravelry-url-step2').style.display = 'none';
        document.getElementById('ravelry-url-back').style.display = 'none';
        const dupWarn = document.getElementById('ravelry-duplicate-warning');
        if (dupWarn) dupWarn.style.display = 'none';
        const nameEl = document.getElementById('ravelry-import-name');
        if (nameEl) delete nameEl.dataset.alreadyExists;
        const importStatusEl = document.getElementById('ravelry-import-status');
        if (importStatusEl) { importStatusEl.style.display = 'none'; importStatusEl.style.color = ''; }
    }

    if (ravelryUrlBtn) {
        ravelryUrlBtn.addEventListener('click', () => {
            addMenu.style.display = 'none';
            const modal = document.getElementById('ravelry-url-modal');
            resetRavelryUrlModal();
            if (modal) modal.style.display = 'flex';
            document.getElementById('ravelry-url-input')?.focus();
        });
    }

    document.getElementById('close-ravelry-url-modal')?.addEventListener('click', () => {
        document.getElementById('ravelry-url-modal').style.display = 'none';
        resetRavelryUrlModal();
    });

    document.getElementById('ravelry-url-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.style.display = 'none';
            resetRavelryUrlModal();
        }
    });

    document.getElementById('cancel-ravelry-url')?.addEventListener('click', () => {
        document.getElementById('ravelry-url-modal').style.display = 'none';
        resetRavelryUrlModal();
    });

    document.getElementById('preview-ravelry-url')?.addEventListener('click', previewRavelryUrl);

    document.getElementById('ravelry-url-back')?.addEventListener('click', () => {
        document.getElementById('ravelry-url-step2').style.display = 'none';
        document.getElementById('ravelry-url-step1').style.display = '';
        document.getElementById('ravelry-url-back').style.display = 'none';
        const previewBtn = document.getElementById('preview-ravelry-url');
        if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = 'Next'; }
    });

    document.getElementById('submit-ravelry-url')?.addEventListener('click', handleRavelryUrlImport);

    document.getElementById('ravelry-url-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') previewRavelryUrl();
    });

    if (closeUploadPanel) {
        closeUploadPanel.addEventListener('click', hideUploadPanel);
    }

    if (closeNewPatternPanel) {
        closeNewPatternPanel.addEventListener('click', hideNewPatternPanel);
    }
}

function showUploadPanel() {
    const uploadPanel = document.getElementById('upload-panel');
    const patternsContainer = document.querySelector('#library .patterns-container');
    if (uploadPanel) {
        uploadPanel.style.display = 'flex';
    }
    if (patternsContainer) {
        patternsContainer.style.display = 'none';
    }
    // Switch to library tab if not there
    switchToTab('library');
}

function hideUploadPanel() {
    const uploadPanel = document.getElementById('upload-panel');
    const patternsContainer = document.querySelector('#library .patterns-container');
    if (uploadPanel) {
        uploadPanel.style.display = 'none';
    }
    if (patternsContainer) {
        patternsContainer.style.display = 'block';
    }
    // Refresh patterns list
    loadPatterns();
    loadCurrentPatterns();
}

async function showNewPatternPanel() {
    const newPatternPanel = document.getElementById('new-pattern-panel');
    const patternsContainer = document.querySelector('#library .patterns-container');

    // Always reload categories and hashtags to ensure fresh data
    await loadCategories();
    await loadHashtags();

    // Populate category dropdown
    const categoryContainer = document.getElementById('new-pattern-category-container');
    if (categoryContainer) {
        categoryContainer.innerHTML = createCategoryDropdown('new-pattern-category', getDefaultCategory());
    }

    // Populate hashtag selector
    const hashtagContainer = document.getElementById('new-pattern-hashtags-container');
    if (hashtagContainer) {
        hashtagContainer.innerHTML = createHashtagSelector('new-pattern-hashtags', []);
    }

    // Clear form
    document.getElementById('new-pattern-name').value = '';
    document.getElementById('new-pattern-description').value = '';
    document.getElementById('new-pattern-content').value = '';
    document.getElementById('new-pattern-is-current').checked = false;
    document.getElementById('new-pattern-rating').innerHTML = ratingInputHtml('new-pattern-rating-input', 0);
    document.getElementById('new-pattern-preview').innerHTML = '<p style="color: var(--text-muted);">Preview will appear here...</p>';

    // Clear thumbnail selector
    const thumbnailPreview = document.getElementById('new-pattern-thumbnail-preview');
    if (thumbnailPreview) {
        thumbnailPreview.innerHTML = '<span class="thumbnail-selector-placeholder">+</span>';
        thumbnailPreview.classList.remove('has-image');
    }
    // Clear any stored thumbnail data
    if (typeof window.thumbnailData !== 'undefined') {
        window.thumbnailData['new-pattern'] = null;
    }

    // Reset editor to edit mode
    const editorWrapper = document.querySelector('.new-pattern-editor-wrapper');
    const livePreviewCheckbox = document.getElementById('new-pattern-live-preview');
    const tabs = document.querySelectorAll('.new-pattern-tab');

    if (editorWrapper) {
        editorWrapper.classList.remove('edit-mode', 'preview-mode', 'live-preview-mode');
        editorWrapper.classList.add('edit-mode');
    }
    if (livePreviewCheckbox) {
        livePreviewCheckbox.checked = false;
    }
    tabs.forEach(tab => {
        tab.style.display = '';
        tab.classList.toggle('active', tab.dataset.tab === 'edit');
    });

    if (newPatternPanel) {
        newPatternPanel.style.display = 'flex';
    }
    if (patternsContainer) {
        patternsContainer.style.display = 'none';
    }
    // Switch to library tab if not there
    switchToTab('library');
}

function hideNewPatternPanel() {
    const newPatternPanel = document.getElementById('new-pattern-panel');
    const patternsContainer = document.querySelector('#library .patterns-container');
    if (newPatternPanel) {
        newPatternPanel.style.display = 'none';
    }
    if (patternsContainer) {
        patternsContainer.style.display = 'block';
    }
    // Clear the thumbnail selector
    clearThumbnailSelector('new-pattern');
}

// New Pattern Panel
function initNewPatternPanel() {
    const contentEditor = document.getElementById('new-pattern-content');
    const preview = document.getElementById('new-pattern-preview');
    const editorWrapper = document.querySelector('.new-pattern-editor-wrapper');
    const saveBtn = document.getElementById('save-new-pattern');
    const cancelBtn = document.getElementById('cancel-new-pattern');
    const livePreviewCheckbox = document.getElementById('new-pattern-live-preview');

    // Set initial mode to edit
    if (editorWrapper) {
        editorWrapper.classList.add('edit-mode');
    }

    // Tab switching
    document.querySelectorAll('.new-pattern-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.tab;
            switchNewPatternTab(mode);
        });
    });

    // Live preview toggle
    if (livePreviewCheckbox) {
        livePreviewCheckbox.addEventListener('change', () => {
            toggleNewPatternLivePreview(livePreviewCheckbox.checked);
        });
    }

    // Update preview on input (for live preview mode)
    if (contentEditor && preview) {
        contentEditor.addEventListener('input', () => {
            updateNewPatternPreview();
        });
        // Enable auto-continue for lists and image paste
        setupMarkdownListContinuation(contentEditor);
        setupImagePaste(contentEditor, () => document.getElementById('new-pattern-name').value || 'new-pattern');
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', saveNewPattern);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', hideNewPatternPanel);
    }
}

function switchNewPatternTab(mode) {
    const editorWrapper = document.querySelector('.new-pattern-editor-wrapper');
    const tabs = document.querySelectorAll('.new-pattern-tab');
    const livePreviewCheckbox = document.getElementById('new-pattern-live-preview');

    // Update tab active states
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === mode);
    });

    // Remove all mode classes
    editorWrapper.classList.remove('edit-mode', 'preview-mode', 'live-preview-mode');

    // Check if live preview is enabled
    if (livePreviewCheckbox && livePreviewCheckbox.checked) {
        editorWrapper.classList.add('live-preview-mode');
    } else {
        editorWrapper.classList.add(mode + '-mode');
    }

    // Update preview content when switching to preview
    if (mode === 'preview' || (livePreviewCheckbox && livePreviewCheckbox.checked)) {
        updateNewPatternPreview();
    }
}

let newPatternScrollSyncCleanup = null;

function toggleNewPatternLivePreview(enabled) {
    const editorWrapper = document.querySelector('.new-pattern-editor-wrapper');
    const tabs = document.querySelectorAll('.new-pattern-tab');

    // Remove all mode classes
    editorWrapper.classList.remove('edit-mode', 'preview-mode', 'live-preview-mode');

    // Clean up previous scroll sync
    if (newPatternScrollSyncCleanup) {
        newPatternScrollSyncCleanup();
        newPatternScrollSyncCleanup = null;
    }

    if (enabled) {
        // Enable live preview - show both panes
        editorWrapper.classList.add('live-preview-mode');
        // Hide tabs when in live preview
        tabs.forEach(tab => tab.style.display = 'none');
        updateNewPatternPreview();
        // Set up scroll sync
        const editor = document.getElementById('new-pattern-content');
        const preview = document.getElementById('new-pattern-preview');
        if (editor && preview) {
            newPatternScrollSyncCleanup = setupScrollSync(editor, preview);
        }
    } else {
        // Disable live preview - go back to edit mode
        editorWrapper.classList.add('edit-mode');
        // Show tabs
        tabs.forEach(tab => tab.style.display = '');
        // Reset to edit tab
        tabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === 'edit');
        });
    }
}

function updateNewPatternPreview() {
    const contentEditor = document.getElementById('new-pattern-content');
    const preview = document.getElementById('new-pattern-preview');

    if (contentEditor && preview) {
        const content = contentEditor.value;
        preview.innerHTML = content
            ? renderMarkdown(content)
            : '<p style="color: var(--text-muted);">Preview will appear here...</p>';
        // Auto-scroll preview to bottom when editor is near the bottom
        const editorNearBottom = contentEditor.scrollHeight - contentEditor.scrollTop - contentEditor.clientHeight < 50;
        if (editorNearBottom) {
            preview.scrollTop = preview.scrollHeight;
        }
    }
}

// Thumbnail Selector
const thumbnailData = {
    currentTarget: null, // 'new-pattern', 'markdown-edit', 'edit'
    selectedFile: null,
    selectedBlob: null
};

function initThumbnailSelector() {
    const modal = document.getElementById('thumbnail-modal');
    const closeBtn = document.getElementById('close-thumbnail-modal');
    const cancelBtn = document.getElementById('cancel-thumbnail-btn');
    const confirmBtn = document.getElementById('confirm-thumbnail-btn');
    const clearBtn = document.getElementById('thumbnail-clear-btn');
    const browseBtn = document.getElementById('thumbnail-browse-btn');
    const pasteBtn = document.getElementById('thumbnail-paste-btn');
    const fileInput = document.getElementById('thumbnail-file-input');

    // Click handlers for thumbnail selectors
    document.querySelectorAll('.thumbnail-selector').forEach(selector => {
        selector.addEventListener('click', () => {
            const target = selector.dataset.target;
            openThumbnailModal(target);
        });
    });

    // Close modal
    if (closeBtn) closeBtn.addEventListener('click', closeThumbnailModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeThumbnailModal);

    // Confirm selection
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            confirmThumbnailSelection();
        });
    }

    // Clear
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearThumbnailPreview();
        });
    }

    // Browse files
    if (browseBtn && fileInput) {
        browseBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) {
                handleThumbnailFile(e.target.files[0]);
            }
        });
    }

    // Paste button
    if (pasteBtn) {
        pasteBtn.addEventListener('click', async () => {
            try {
                const clipboardItems = await navigator.clipboard.read();
                for (const item of clipboardItems) {
                    for (const type of item.types) {
                        if (type.startsWith('image/')) {
                            const blob = await item.getType(type);
                            handleThumbnailBlob(blob);
                            return;
                        }
                    }
                }
                alert('No image found in clipboard');
            } catch (err) {
                console.error('Failed to read clipboard:', err);
                alert('Could not access clipboard. Try using Ctrl+V instead.');
            }
        });
    }

    // Global paste handler for the modal
    document.addEventListener('paste', (e) => {
        const modal = document.getElementById('thumbnail-modal');
        if (modal.style.display !== 'none') {
            const items = e.clipboardData?.items;
            if (items) {
                for (const item of items) {
                    if (item.type.startsWith('image/')) {
                        e.preventDefault();
                        const blob = item.getAsFile();
                        handleThumbnailBlob(blob);
                        return;
                    }
                }
            }
        }
    });

    // Click outside to close
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeThumbnailModal();
        });
    }

    // Drag and drop on the preview area
    const previewArea = document.getElementById('thumbnail-preview-area');
    if (previewArea) {
        previewArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            previewArea.classList.add('drag-over');
        });

        previewArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            previewArea.classList.remove('drag-over');
        });

        previewArea.addEventListener('drop', (e) => {
            e.preventDefault();
            previewArea.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
                handleThumbnailFile(file);
            }
        });
    }
}

function openThumbnailModal(target) {
    thumbnailData.currentTarget = target;
    thumbnailData.selectedFile = null;
    thumbnailData.selectedBlob = null;

    // Reset modal state
    clearThumbnailPreview();

    // Check if there's an existing thumbnail for this target
    const selectorPreview = document.getElementById(`${target}-thumbnail-preview`);
    const existingImg = selectorPreview?.querySelector('img');
    if (existingImg) {
        // Show existing thumbnail in modal
        const previewImg = document.getElementById('thumbnail-preview-img');
        const placeholder = document.getElementById('thumbnail-placeholder');
        const previewArea = document.getElementById('thumbnail-preview-area');

        previewImg.src = existingImg.src;
        previewImg.style.display = 'block';
        placeholder.style.display = 'none';
        previewArea.classList.add('has-image');
    }

    document.getElementById('thumbnail-modal').style.display = 'flex';
    document.getElementById('thumbnail-file-input').value = '';
}

function closeThumbnailModal() {
    document.getElementById('thumbnail-modal').style.display = 'none';
    thumbnailData.currentTarget = null;
    thumbnailData.selectedFile = null;
    thumbnailData.selectedBlob = null;
}

function clearThumbnailPreview() {
    const previewImg = document.getElementById('thumbnail-preview-img');
    const placeholder = document.getElementById('thumbnail-placeholder');
    const previewArea = document.getElementById('thumbnail-preview-area');

    previewImg.src = '';
    previewImg.style.display = 'none';
    placeholder.style.display = 'flex';
    previewArea.classList.remove('has-image');

    thumbnailData.selectedFile = null;
    thumbnailData.selectedBlob = null;
}

function handleThumbnailFile(file) {
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
    }
    thumbnailData.selectedFile = file;
    thumbnailData.selectedBlob = null;

    const reader = new FileReader();
    reader.onload = (e) => {
        showThumbnailPreview(e.target.result);
    };
    reader.readAsDataURL(file);
}

function handleThumbnailBlob(blob) {
    thumbnailData.selectedBlob = blob;
    thumbnailData.selectedFile = null;

    const reader = new FileReader();
    reader.onload = (e) => {
        showThumbnailPreview(e.target.result);
    };
    reader.readAsDataURL(blob);
}

function showThumbnailPreview(dataUrl) {
    const previewImg = document.getElementById('thumbnail-preview-img');
    const placeholder = document.getElementById('thumbnail-placeholder');
    const previewArea = document.getElementById('thumbnail-preview-area');

    previewImg.src = dataUrl;
    previewImg.style.display = 'block';
    placeholder.style.display = 'none';
    previewArea.classList.add('has-image');
}

async function confirmThumbnailSelection() {
    const target = thumbnailData.currentTarget;
    console.log('confirmThumbnailSelection for target:', target);
    const selectorPreview = document.getElementById(`${target}-thumbnail-preview`);

    if (!selectorPreview) {
        console.log('No selectorPreview found, closing modal');
        closeThumbnailModal();
        return;
    }

    // Get the image data
    let imageBlob = thumbnailData.selectedBlob;
    console.log('thumbnailData:', { selectedFile: thumbnailData.selectedFile, selectedBlob: thumbnailData.selectedBlob });
    if (thumbnailData.selectedFile) {
        imageBlob = thumbnailData.selectedFile;
    } else if (!imageBlob) {
        // Check if we should clear the selection
        const previewImg = document.getElementById('thumbnail-preview-img');
        if (!previewImg.src || previewImg.style.display === 'none') {
            // Clear the selector
            selectorPreview.innerHTML = '<span class="thumbnail-selector-placeholder">+</span>';
            selectorPreview.classList.remove('has-image');
            // Store null to indicate cleared
            selectorPreview.dataset.thumbnailCleared = 'true';
            delete selectorPreview.dataset.thumbnailBlob;
            closeThumbnailModal();
            return;
        }
        // No new selection, keep existing
        closeThumbnailModal();
        return;
    }

    // Resize the image and update the selector preview
    try {
        console.log('Resizing image blob:', imageBlob);
        const resizedBlob = await resizeThumbnail(imageBlob, 400, 400);
        console.log('Resized blob size:', resizedBlob.size);
        const dataUrl = await blobToDataUrl(resizedBlob);
        console.log('Data URL created, length:', dataUrl.length);

        // Update the selector preview
        selectorPreview.innerHTML = `<img src="${dataUrl}" alt="Thumbnail">`;
        selectorPreview.classList.add('has-image');
        selectorPreview.dataset.thumbnailCleared = 'false';

        // Store the blob for later upload (convert to base64 for storage)
        selectorPreview.dataset.thumbnailBlob = dataUrl;
        console.log('Stored thumbnailBlob in dataset for target:', target);
    } catch (err) {
        console.error('Error processing thumbnail:', err);
        alert('Error processing image');
    }

    closeThumbnailModal();
}

function resizeThumbnail(blob, maxWidth, maxHeight) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;

            // Calculate new dimensions maintaining aspect ratio
            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }

            // Create canvas and draw resized image
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // Convert to blob
            canvas.toBlob((resultBlob) => {
                if (resultBlob) {
                    resolve(resultBlob);
                } else {
                    reject(new Error('Failed to create blob'));
                }
            }, 'image/jpeg', 0.85);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = URL.createObjectURL(blob);
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const binary = atob(parts[1]);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
}

function getThumbnailFile(target) {
    const selectorPreview = document.getElementById(`${target}-thumbnail-preview`);
    console.log('getThumbnailFile for target:', target, 'selectorPreview:', selectorPreview);
    if (!selectorPreview) {
        console.log('No selectorPreview element found');
        return null;
    }

    // Check if cleared
    if (selectorPreview.dataset.thumbnailCleared === 'true') {
        console.log('Thumbnail was cleared');
        return null;
    }

    const dataUrl = selectorPreview.dataset.thumbnailBlob;
    console.log('thumbnailBlob data URL present:', !!dataUrl, dataUrl ? dataUrl.substring(0, 50) + '...' : null);
    if (!dataUrl) {
        console.log('No thumbnailBlob data URL');
        return null;
    }

    // Convert data URL back to File for FormData
    const blob = dataUrlToBlob(dataUrl);
    const file = new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' });
    console.log('Created File from blob:', file.name, file.size, 'bytes');
    return file;
}

function clearThumbnailSelector(target) {
    const selectorPreview = document.getElementById(`${target}-thumbnail-preview`);
    if (selectorPreview) {
        selectorPreview.innerHTML = '<span class="thumbnail-selector-placeholder">+</span>';
        selectorPreview.classList.remove('has-image');
        delete selectorPreview.dataset.thumbnailBlob;
        delete selectorPreview.dataset.thumbnailCleared;
    }
}

function setThumbnailSelectorImage(target, imageUrl) {
    const selectorPreview = document.getElementById(`${target}-thumbnail-preview`);
    if (selectorPreview && imageUrl) {
        const img = document.createElement('img');
        img.alt = 'Thumbnail';
        img.onload = () => {
            selectorPreview.innerHTML = '';
            selectorPreview.appendChild(img);
            selectorPreview.classList.add('has-image');
        };
        img.onerror = () => {
            // Image failed to load, show placeholder instead
            clearThumbnailSelector(target);
        };
        img.src = imageUrl;
        delete selectorPreview.dataset.thumbnailBlob;
        delete selectorPreview.dataset.thumbnailCleared;
    }
}

async function saveNewPattern() {
    const name = document.getElementById('new-pattern-name').value.trim();
    const category = getCategoryDropdownValue('new-pattern-category');
    const description = document.getElementById('new-pattern-description').value.trim();
    const content = document.getElementById('new-pattern-content').value;
    const isCurrent = document.getElementById('new-pattern-is-current').checked;
    const rating = parseInt(document.getElementById('new-pattern-rating-input')?.dataset.rating) || 0;
    const hashtagIds = getSelectedHashtagIds('new-pattern-hashtags');
    const thumbnailFile = getThumbnailFile('new-pattern');

    if (!name) {
        alert('Please enter a pattern name');
        return;
    }

    if (!content.trim()) {
        alert('Please enter pattern content');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/patterns/markdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                category,
                description,
                content,
                isCurrent,
                rating,
                hashtagIds
            })
        });

        if (!response.ok) {
            const text = await response.text();
            let errorMsg = 'Failed to create pattern';
            try {
                const error = JSON.parse(text);
                errorMsg = error.error || errorMsg;
            } catch {
                console.error('Server response:', text);
            }
            throw new Error(errorMsg);
        }

        const pattern = await response.json();
        console.log('Created markdown pattern:', pattern);

        // Upload thumbnail if provided
        if (thumbnailFile && pattern.id) {
            console.log('Uploading new pattern thumbnail:', thumbnailFile.name, thumbnailFile.size, 'bytes');
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            const thumbResponse = await fetch(`${API_URL}/api/patterns/${pattern.id}/thumbnail`, {
                method: 'POST',
                body: formData
            });
            if (!thumbResponse.ok) {
                console.error('Thumbnail upload failed:', await thumbResponse.text());
            } else {
                console.log('Thumbnail uploaded successfully');
            }
        } else {
            console.log('No thumbnail file for new pattern, thumbnailFile:', thumbnailFile, 'pattern.id:', pattern?.id);
        }

        hideNewPatternPanel();
        await loadPatterns();
        await loadCurrentPatterns();
        await loadCategories();

    } catch (error) {
        console.error('Error creating pattern:', error);
        alert(error.message);
    }
}

function applyInventoryTabVisibility() {
    const btn = document.getElementById('inventory-tab-btn');
    if (btn) btn.style.display = showInventoryTab ? '' : 'none';
}

function updateTabCounts() {
    const currentCount = document.getElementById('current-tab-count');
    const libraryCount = document.getElementById('library-tab-count');
    const projectsCount = document.getElementById('projects-tab-count');

    // Current tab shows patterns + projects that are marked current
    const totalCurrent = currentPatterns.length + currentProjects.length;

    if (currentCount) {
        currentCount.textContent = showTabCounts ? ` (${totalCurrent})` : '';
    }
    if (libraryCount) {
        libraryCount.textContent = showTabCounts ? ` (${patterns.length})` : '';
    }
    if (projectsCount) {
        projectsCount.textContent = showTabCounts ? ` (${projects.length})` : '';
    }
    const inventoryCount = document.getElementById('inventory-tab-count');
    if (inventoryCount) {
        const total = yarns.length + hooks.length;
        inventoryCount.textContent = showTabCounts && total > 0 ? ` (${total})` : '';
    }
}

async function loadLibraryStats() {
    try {
        const response = await fetch(`${API_URL}/api/stats`);
        const stats = await response.json();

        const container = document.getElementById('library-stats');
        if (!container) return;

        // Format file size
        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + '\u2009B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + '\u2009KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + '\u2009MB';
            return (bytes / (1024 * 1024 * 1024)).toFixed(1) + '\u2009GB';
        };

        container.innerHTML = `
            <div class="library-stats-grid">
                <div class="stat-item">
                    <span class="stat-value">${stats.totalPatterns}</span>
                    <span class="stat-label">Total Pattern${stats.totalPatterns === 1 ? '' : 's'}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.currentPatterns}</span>
                    <span class="stat-label">In Progress</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${(stats.totalRowsCounted || 0).toLocaleString()}</span>
                    <span class="stat-label">Row${stats.totalRowsCounted === 1 ? '' : 's'} Counted</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.completedPatterns}</span>
                    <span class="stat-label">Pattern${stats.completedPatterns === 1 ? '' : 's'} Completed</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${formatTime(stats.totalTimeSeconds || 0)}</span>
                    <span class="stat-label">Total Time Crocheting</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.patternsWithTime > 0 ? formatTime(Math.round((stats.totalTimeSeconds || 0) / stats.patternsWithTime)) : '–'}</span>
                    <span class="stat-label">Avg Time per Project</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${formatSize(stats.totalSize)}</span>
                    <span class="stat-label">Library Size</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.totalCategories || 0}</span>
                    <span class="stat-label">Categor${stats.totalCategories === 1 ? 'y' : 'ies'}</span>
                </div>
            </div>
            <div class="library-location">
                <span class="location-label">Library Location:</span>
                <code>${escapeHtml(stats.libraryPath)}</code>
            </div>
            ${stats.patternsByCategory.length > 0 ? `
                <div class="stats-categories">
                    <h4>Patterns by Category</h4>
                    <div class="category-stats">
                        ${stats.patternsByCategory.map(cat => `
                            <div class="category-stat-item">
                                <span class="category-stat-name">${escapeHtml(cat.name)}</span>
                                <span class="category-stat-count">${cat.count}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            ${stats.adminStats ? `
                <div class="admin-stats-section">
                    <h4>Admin Stats</h4>
                    <div class="library-stats-grid">
                        <div class="stat-item">
                            <span class="stat-value">${stats.adminStats.totalUsers}</span>
                            <span class="stat-label">User${stats.adminStats.totalUsers === 1 ? '' : 's'}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${stats.totalPatterns}</span>
                            <span class="stat-label">Total Pattern${stats.totalPatterns === 1 ? '' : 's'}</span>
                        </div>
                    </div>
                    ${stats.adminStats.userBreakdown.length > 1 ? `
                        <div class="admin-user-breakdown">
                            <h4>Per-User Breakdown</h4>
                            <div class="user-breakdown-table">
                                <div class="user-breakdown-header">
                                    <span>User</span>
                                    <span>Patterns</span>
                                    <span>Completed</span>
                                    <span>Time</span>
                                </div>
                                ${stats.adminStats.userBreakdown.map(u => `
                                    <div class="user-breakdown-row">
                                        <span class="user-breakdown-name">${escapeHtml(u.username)}</span>
                                        <span>${u.patternCount}</span>
                                        <span>${u.completedCount}</span>
                                        <span>${formatTime(u.totalTime)}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            ` : ''}
        `;
        // Load version from API
        const versionEl = document.getElementById('app-version');
        if (versionEl) {
            const vRes = await fetch(`${API_URL}/api/version`);
            if (vRes.ok) {
                const vData = await vRes.json();
                versionEl.textContent = vData.version;
            }
        }
    } catch (error) {
        console.error('Error loading library stats:', error);
    }
}


// Backup Functions
async function loadBackups() {
    const container = document.getElementById('backups-list');
    if (!container) return;

    try {
        const response = await fetch(`${API_URL}/api/backups`);
        const backups = await response.json();

        if (backups.length === 0) {
            container.innerHTML = '<p class="no-backups">No backups yet. Create your first backup above.</p>';
            return;
        }

        container.innerHTML = backups.map(backup => `
            <div class="backup-item" data-filename="${escapeHtml(backup.filename)}">
                <div class="backup-info">
                    <span class="backup-name">${escapeHtml(backup.filename)}</span>
                    <span class="backup-meta">${formatBackupSize(backup.size)} • ${formatBackupDate(backup.created)}</span>
                </div>
                <div class="backup-actions">
                    <button class="btn btn-small btn-secondary" onclick="downloadBackup('${escapeHtml(backup.filename)}')" title="Download">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                    </button>
                    <button class="btn btn-small btn-primary" onclick="restoreBackup('${escapeHtml(backup.filename)}')" title="Restore">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="1 4 1 10 7 10"></polyline>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                        </svg>
                    </button>
                    <button class="btn btn-small btn-danger" onclick="deleteBackup('${escapeHtml(backup.filename)}')" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading backups:', error);
        container.innerHTML = '<p class="no-backups">Error loading backups.</p>';
    }
}

function formatBackupSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatBackupDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getClientSettings() {
    const settings = {};
    for (const key of SYNCED_SETTING_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) {
            settings[key] = value;
        }
    }
    return settings;
}

function applyClientSettings(settings) {
    if (!settings) return;

    // Apply each setting using original setItem to avoid triggering sync loop
    Object.entries(settings).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            _originalSetItem(key, value);
        }
    });

    // Sync restored settings to server before reloading
    syncSettingsToServer();

    // Reload the page to apply all settings
    window.location.reload();
}

async function createBackup() {
    const btn = document.getElementById('create-backup-btn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating backup...';

    const includePatterns = document.getElementById('backup-include-patterns')?.checked ?? true;
    const includeMarkdown = document.getElementById('backup-include-markdown')?.checked ?? true;
    const includeArchive = document.getElementById('backup-include-archive')?.checked ?? false;
    const includeNotes = document.getElementById('backup-include-notes')?.checked ?? true;

    try {
        const response = await fetch(`${API_URL}/api/backups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientSettings: getClientSettings(),
                includePatterns,
                includeMarkdown,
                includeArchive,
                includeNotes
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create backup');
        }

        const result = await response.json();
        await loadBackups();
        showToast(`Backup created: ${result.filename}`, 'success');
    } catch (error) {
        console.error('Error creating backup:', error);
        showToast('Error creating backup: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

function downloadBackup(filename) {
    window.location.href = `${API_URL}/api/backups/${encodeURIComponent(filename)}/download`;
}

async function restoreBackup(filename) {
    if (!confirm(`Are you sure you want to restore from "${filename}"?\n\nThis will replace all current patterns, settings, and data. This action cannot be undone.`)) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/backups/${encodeURIComponent(filename)}/restore`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to restore backup');
        }

        const result = await response.json();

        // Apply client settings if present
        if (result.clientSettings) {
            applyClientSettings(result.clientSettings);
        } else {
            showToast('Backup restored successfully!', 'success');
            window.location.reload();
        }
    } catch (error) {
        console.error('Error restoring backup:', error);
        showToast('Error restoring backup: ' + error.message, 'error');
    }
}

async function deleteBackup(filename) {
    if (!confirm(`Are you sure you want to delete "${filename}"?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/backups/${encodeURIComponent(filename)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete backup');
        }

        await loadBackups();
        showToast('Backup deleted', 'success');
    } catch (error) {
        console.error('Error deleting backup:', error);
        showToast('Error deleting backup: ' + error.message, 'error');
    }
}

// Admin Backup Functions
async function downloadAdminConfig() {
    try {
        showToast('Downloading configuration...');
        window.location.href = `${API_URL}/api/admin/backup/config`;
    } catch (error) {
        console.error('Error downloading admin config:', error);
        showToast('Error downloading configuration', 'error');
    }
}

async function restoreAdminConfig(file) {
    try {
        const text = await file.text();
        const config = JSON.parse(text);

        if (!config.version || !config.exportedAt) {
            showToast('Invalid config backup file', 'error');
            return;
        }

        // Show confirmation dialog
        const userCount = config.users?.length || 0;
        const hasOidc = config.settings?.oidc ? 'Yes' : 'No';

        if (!confirm(`Restore configuration?\n\nUsers: ${userCount}\nOIDC settings: ${hasOidc}\n\nExisting users will be updated, new users will be created.`)) {
            return;
        }

        showToast('Restoring configuration...');

        const response = await fetch(`${API_URL}/api/admin/backup/config/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config,
                restoreUsers: true,
                restoreSettings: true
            })
        });

        if (response.ok) {
            const result = await response.json();
            showToast(`Configuration restored: ${result.restored.usersCreated || 0} users created, ${result.restored.usersUpdated || 0} updated`);
            loadUsers();
            loadOIDCSettings();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to restore configuration', 'error');
        }
    } catch (error) {
        console.error('Error restoring admin config:', error);
        showToast('Error restoring configuration: ' + error.message, 'error');
    }
}

async function downloadAdminData() {
    try {
        showToast('Preparing data download... This may take a while for large libraries.');
        window.location.href = `${API_URL}/api/admin/backup/data`;
    } catch (error) {
        console.error('Error downloading admin data:', error);
        showToast('Error downloading data', 'error');
    }
}

async function restoreAdminData(file) {
    try {
        if (!confirm('Restore all user data from backup?\n\nThis will overwrite existing files for users found in the backup.')) {
            return;
        }

        showToast('Uploading and restoring data... This may take a while.');

        const formData = new FormData();
        formData.append('backup', file);

        const response = await fetch(`${API_URL}/api/admin/backup/data/upload`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const result = await response.json();
            showToast(`Data restored: ${result.message}`);
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to restore data', 'error');
        }
    } catch (error) {
        console.error('Error restoring admin data:', error);
        showToast('Error restoring data: ' + error.message, 'error');
    }
}

function initBackups() {
    const createBtn = document.getElementById('create-backup-btn');
    if (createBtn) {
        createBtn.addEventListener('click', createBackup);
    }

    // Include patterns checkbox - update estimate when changed
    const includePatterns = document.getElementById('backup-include-patterns');
    if (includePatterns) {
        includePatterns.addEventListener('change', updateBackupEstimate);
    }

    // Include markdown checkbox - update estimate when changed
    const includeMarkdown = document.getElementById('backup-include-markdown');
    if (includeMarkdown) {
        includeMarkdown.addEventListener('change', updateBackupEstimate);
    }

    // Include archive checkbox - update estimate when changed
    const includeArchive = document.getElementById('backup-include-archive');
    if (includeArchive) {
        includeArchive.addEventListener('change', updateBackupEstimate);
    }

    // Include notes checkbox - update estimate when changed
    const includeNotes = document.getElementById('backup-include-notes');
    if (includeNotes) {
        includeNotes.addEventListener('change', updateBackupEstimate);
    }

    // Load library size for the backup option
    loadLibrarySizeForBackup();

    // Schedule toggle and options
    const scheduleEnabled = document.getElementById('backup-schedule-enabled');
    const scheduleOptions = document.getElementById('backup-schedule-options');
    const scheduleSelect = document.getElementById('backup-schedule-select');
    const timeInput = document.getElementById('backup-time-input');

    // Prune toggle and options (declared here so they're available in save/load functions)
    const pruneEnabled = document.getElementById('backup-prune-enabled');
    const pruneOptions = document.getElementById('backup-prune-options');
    const pruneMode = document.getElementById('backup-prune-mode');
    const pruneKeepContainer = document.getElementById('prune-keep-container');
    const pruneAgeContainer = document.getElementById('prune-age-container');
    const pruneValue = document.getElementById('backup-prune-value');
    const pruneAgeValue = document.getElementById('backup-prune-age-value');
    const pruneAgeUnit = document.getElementById('backup-prune-age-unit');

    const updateScheduleVisibility = () => {
        if (scheduleOptions) {
            scheduleOptions.style.display = scheduleEnabled && scheduleEnabled.checked ? 'block' : 'none';
        }
    };

    // Save backup schedule settings to server
    const saveScheduleSettings = async (showMessage = true, message = 'Backup settings updated') => {
        try {
            await fetch(`${API_URL}/api/backups/schedule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: scheduleEnabled?.checked ?? false,
                    schedule: scheduleSelect?.value ?? 'daily',
                    time: timeInput?.value ?? '03:00',
                    includePatterns: includePatterns?.checked ?? true,
                    includeMarkdown: includeMarkdown?.checked ?? true,
                    includeArchive: includeArchive?.checked ?? false,
                    includeNotes: includeNotes?.checked ?? true,
                    pruneEnabled: pruneEnabled?.checked ?? false,
                    pruneMode: pruneMode?.value ?? 'keep',
                    pruneValue: parseInt(pruneValue?.value ?? '5'),
                    pruneAgeValue: parseInt(pruneAgeValue?.value ?? '30'),
                    pruneAgeUnit: pruneAgeUnit?.value ?? 'days'
                })
            });
            if (showMessage) showToast(message);
        } catch (error) {
            console.error('Error saving backup settings:', error);
        }
    };

    // Load backup schedule settings from server
    const loadScheduleSettings = async () => {
        try {
            const response = await fetch(`${API_URL}/api/backups/schedule`);
            const settings = await response.json();

            if (scheduleEnabled) scheduleEnabled.checked = settings.enabled;
            if (scheduleSelect) scheduleSelect.value = settings.schedule || 'daily';
            if (timeInput) timeInput.value = settings.time || '03:00';
            if (includePatterns) includePatterns.checked = settings.includePatterns ?? true;
            if (includeMarkdown) includeMarkdown.checked = settings.includeMarkdown ?? true;
            if (includeArchive) includeArchive.checked = settings.includeArchive ?? false;
            if (includeNotes) includeNotes.checked = settings.includeNotes ?? true;
            if (pruneEnabled) pruneEnabled.checked = settings.pruneEnabled ?? false;
            if (pruneMode) pruneMode.value = settings.pruneMode || 'keep';
            if (pruneValue) pruneValue.value = settings.pruneValue || '5';
            if (pruneAgeValue) pruneAgeValue.value = settings.pruneAgeValue || '30';
            if (pruneAgeUnit) pruneAgeUnit.value = settings.pruneAgeUnit || 'days';

            updateScheduleVisibility();
            updatePruneVisibility();
            updatePruneModeContainers();
        } catch (error) {
            console.error('Error loading backup settings:', error);
        }
    };

    if (scheduleEnabled) {
        scheduleEnabled.addEventListener('change', () => {
            updateScheduleVisibility();
            saveScheduleSettings(true, scheduleEnabled.checked ? 'Backup schedule enabled' : 'Backup schedule disabled');
        });
    }

    if (scheduleSelect) {
        scheduleSelect.addEventListener('change', () => {
            saveScheduleSettings(true, 'Backup frequency updated');
        });
    }

    if (timeInput) {
        let lastTimeValue = timeInput.value;
        timeInput.addEventListener('blur', () => {
            if (timeInput.value !== lastTimeValue) {
                lastTimeValue = timeInput.value;
                saveScheduleSettings(true, 'Backup time updated');
            }
        });
    }

    if (includePatterns) {
        includePatterns.addEventListener('change', () => {
            saveScheduleSettings(true, includePatterns.checked ? 'PDF patterns will be included' : 'PDF patterns excluded from backup');
        });
    }

    if (includeMarkdown) {
        includeMarkdown.addEventListener('change', () => {
            saveScheduleSettings(true, includeMarkdown.checked ? 'Markdown patterns will be included' : 'Markdown patterns excluded from backup');
        });
    }

    if (includeArchive) {
        includeArchive.addEventListener('change', () => {
            saveScheduleSettings(true, includeArchive.checked ? 'Archive will be included' : 'Archive excluded from backup');
        });
    }

    if (includeNotes) {
        includeNotes.addEventListener('change', () => {
            saveScheduleSettings(true, includeNotes.checked ? 'Notes will be included' : 'Notes excluded from backup');
        });
    }

    const updatePruneVisibility = () => {
        if (pruneOptions) {
            pruneOptions.style.display = pruneEnabled && pruneEnabled.checked ? 'block' : 'none';
        }
    };

    const updatePruneModeContainers = () => {
        if (pruneKeepContainer && pruneAgeContainer && pruneMode) {
            if (pruneMode.value === 'keep') {
                pruneKeepContainer.style.display = 'flex';
                pruneAgeContainer.style.display = 'none';
            } else {
                pruneKeepContainer.style.display = 'none';
                pruneAgeContainer.style.display = 'flex';
            }
        }
    };

    const getPruneSetting = () => {
        const mode = pruneMode ? pruneMode.value : 'keep';
        if (mode === 'keep') {
            const value = pruneValue ? pruneValue.value : '5';
            return `keep-${value}`;
        } else {
            const value = pruneAgeValue ? pruneAgeValue.value : '30';
            const unit = pruneAgeUnit ? pruneAgeUnit.value : 'days';
            // Convert to days for the API
            let days = parseInt(value);
            if (unit === 'weeks') days *= 7;
            else if (unit === 'months') days *= 30;
            else if (unit === 'years') days *= 365;
            return `days-${days}`;
        }
    };

    const runPruneIfEnabled = async () => {
        if (pruneEnabled && pruneEnabled.checked) {
            await runPrune(getPruneSetting());
        }
    };

    if (pruneEnabled) {
        pruneEnabled.addEventListener('change', async () => {
            updatePruneVisibility();
            if (pruneEnabled.checked) {
                await runPruneIfEnabled();
            }
            saveScheduleSettings(true, pruneEnabled.checked ? 'Auto-prune enabled' : 'Auto-prune disabled');
        });
    }

    if (pruneMode) {
        pruneMode.addEventListener('change', () => {
            updatePruneModeContainers();
            runPruneIfEnabled();
            saveScheduleSettings(true, 'Prune mode updated');
        });
    }

    if (pruneValue) {
        pruneValue.addEventListener('change', () => {
            runPruneIfEnabled();
            saveScheduleSettings(true, 'Prune setting updated');
        });
    }

    if (pruneAgeValue) {
        pruneAgeValue.addEventListener('change', () => {
            runPruneIfEnabled();
            saveScheduleSettings(true, 'Prune setting updated');
        });
    }

    if (pruneAgeUnit) {
        pruneAgeUnit.addEventListener('change', () => {
            runPruneIfEnabled();
            saveScheduleSettings(true, 'Prune setting updated');
        });
    }

    // Admin backup handlers
    const adminBackupConfigBtn = document.getElementById('admin-backup-config-btn');
    if (adminBackupConfigBtn) {
        adminBackupConfigBtn.addEventListener('click', downloadAdminConfig);
    }

    const adminRestoreConfigBtn = document.getElementById('admin-restore-config-btn');
    const adminRestoreConfigInput = document.getElementById('admin-restore-config-input');
    if (adminRestoreConfigBtn && adminRestoreConfigInput) {
        adminRestoreConfigBtn.addEventListener('click', () => adminRestoreConfigInput.click());
        adminRestoreConfigInput.addEventListener('change', (e) => {
            if (e.target.files[0]) {
                restoreAdminConfig(e.target.files[0]);
                e.target.value = '';
            }
        });
    }

    const adminBackupDataBtn = document.getElementById('admin-backup-data-btn');
    if (adminBackupDataBtn) {
        adminBackupDataBtn.addEventListener('click', downloadAdminData);
    }

    const adminRestoreDataBtn = document.getElementById('admin-restore-data-btn');
    const adminRestoreDataInput = document.getElementById('admin-restore-data-input');
    if (adminRestoreDataBtn && adminRestoreDataInput) {
        adminRestoreDataBtn.addEventListener('click', () => adminRestoreDataInput.click());
        adminRestoreDataInput.addEventListener('change', (e) => {
            if (e.target.files[0]) {
                restoreAdminData(e.target.files[0]);
                e.target.value = '';
            }
        });
    }

    loadBackups();
    loadScheduleSettings();
}

// Initialize Notifications Section
function initNotificationsSection() {
    const pushoverEnabled = document.getElementById('pushover-enabled');
    const pushoverSettings = document.getElementById('pushover-settings');
    const pushoverUserKey = document.getElementById('pushover-user-key');
    const pushoverAppToken = document.getElementById('pushover-app-token');
    const pushoverTestBtn = document.getElementById('pushover-test-btn');
    const notifyBackupComplete = document.getElementById('notify-backup-complete');
    const notifyBackupError = document.getElementById('notify-backup-error');
    const notifyAutoDelete = document.getElementById('notify-auto-delete');

    if (!pushoverEnabled) return;

    // Load settings from server
    const loadNotificationSettings = async () => {
        try {
            const response = await fetch(`${API_URL}/api/notifications/settings`);
            const settings = await response.json();

            pushoverEnabled.checked = settings.pushoverEnabled;
            pushoverSettings.style.display = settings.pushoverEnabled ? 'block' : 'none';
            pushoverUserKey.value = settings.pushoverUserKey || '';
            pushoverAppToken.value = settings.pushoverAppToken || '';
            notifyBackupComplete.checked = settings.notifyBackupComplete;
            notifyBackupError.checked = settings.notifyBackupError;
            notifyAutoDelete.checked = settings.notifyAutoDelete;
        } catch (error) {
            console.error('Error loading notification settings:', error);
        }
    };

    // Save settings to server
    const saveNotificationSettings = async (data, message) => {
        try {
            await fetch(`${API_URL}/api/notifications/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (message) showToast(message, 'success');
        } catch (error) {
            console.error('Error saving notification settings:', error);
            showToast('Failed to save settings', 'error');
        }
    };

    // Toggle Pushover settings visibility
    pushoverEnabled.addEventListener('change', () => {
        pushoverSettings.style.display = pushoverEnabled.checked ? 'block' : 'none';
        saveNotificationSettings({ pushoverEnabled: pushoverEnabled.checked }, 'Pushover ' + (pushoverEnabled.checked ? 'enabled' : 'disabled'));
    });

    // Clear masked value on focus so user can enter new key
    pushoverUserKey.addEventListener('focus', () => {
        if (pushoverUserKey.value === '••••••••') {
            pushoverUserKey.value = '';
        }
    });

    pushoverAppToken.addEventListener('focus', () => {
        if (pushoverAppToken.value === '••••••••') {
            pushoverAppToken.value = '';
        }
    });

    // Save credentials on blur
    pushoverUserKey.addEventListener('blur', () => {
        if (pushoverUserKey.value && pushoverUserKey.value !== '••••••••') {
            saveNotificationSettings({ pushoverUserKey: pushoverUserKey.value }, 'User key saved');
            pushoverUserKey.value = '••••••••';
        } else if (!pushoverUserKey.value) {
            // Restore mask if field left empty (user key still saved on server)
            loadNotificationSettings();
        }
    });

    pushoverAppToken.addEventListener('blur', () => {
        if (pushoverAppToken.value && pushoverAppToken.value !== '••••••••') {
            saveNotificationSettings({ pushoverAppToken: pushoverAppToken.value }, 'API token saved');
            pushoverAppToken.value = '••••••••';
        } else if (!pushoverAppToken.value) {
            // Restore mask if field left empty (token still saved on server)
            loadNotificationSettings();
        }
    });

    // Toggle event notifications
    notifyBackupComplete.addEventListener('change', () => {
        saveNotificationSettings({ notifyBackupComplete: notifyBackupComplete.checked },
            'Backup complete notification ' + (notifyBackupComplete.checked ? 'enabled' : 'disabled'));
    });

    notifyBackupError.addEventListener('change', () => {
        saveNotificationSettings({ notifyBackupError: notifyBackupError.checked },
            'Backup error notification ' + (notifyBackupError.checked ? 'enabled' : 'disabled'));
    });

    notifyAutoDelete.addEventListener('change', () => {
        saveNotificationSettings({ notifyAutoDelete: notifyAutoDelete.checked },
            'Auto-delete notification ' + (notifyAutoDelete.checked ? 'enabled' : 'disabled'));
    });

    // Test notification
    pushoverTestBtn.addEventListener('click', async () => {
        pushoverTestBtn.disabled = true;
        pushoverTestBtn.textContent = 'Sending...';

        try {
            const response = await fetch(`${API_URL}/api/notifications/test`, {
                method: 'POST'
            });
            const data = await response.json();

            if (response.ok) {
                showToast('Test notification sent!', 'success');
            } else {
                showToast(data.error || 'Failed to send notification', 'error');
            }
        } catch (error) {
            showToast('Failed to send notification', 'error');
        } finally {
            pushoverTestBtn.disabled = false;
            pushoverTestBtn.textContent = 'Send Test';
        }
    });

    loadNotificationSettings();
}

let cachedLibrarySize = 0;
let cachedImagesSize = 0;
let cachedImagesCount = 0;
let cachedArchiveSize = 0;
let cachedArchiveCount = 0;

async function loadLibrarySizeForBackup() {
    try {
        const response = await fetch(`${API_URL}/api/stats`);
        const stats = await response.json();
        cachedLibrarySize = stats.totalSize || 0;

        const sizeInfo = document.getElementById('pdf-size-info');
        if (sizeInfo) {
            const formattedSize = formatBackupSize(cachedLibrarySize);
            sizeInfo.textContent = `${stats.totalPatterns || 0} patterns (${formattedSize})`;
        }
        // Update backup path display
        const pathDisplay = document.getElementById('backup-path-display');
        if (pathDisplay && stats.backupHostPath) {
            pathDisplay.textContent = stats.backupHostPath;
        }

        // Load markdown/images size
        await loadImagesSizeForBackup();

        // Load archive size
        await loadArchiveSizeForBackup();

        // Load notes size
        await loadNotesSizeForBackup();

        // Update backup estimate
        updateBackupEstimate();
    } catch (error) {
        const sizeInfo = document.getElementById('pdf-size-info');
        if (sizeInfo) {
            sizeInfo.textContent = 'Could not load size';
        }
    }
}

async function loadImagesSizeForBackup() {
    try {
        const response = await fetch(`${API_URL}/api/images/stats`);
        const stats = await response.json();
        cachedImagesSize = stats.totalSize || 0;
        cachedImagesCount = stats.count || 0;

        const sizeInfo = document.getElementById('markdown-size-info');
        if (sizeInfo) {
            const formattedSize = formatBackupSize(cachedImagesSize);
            sizeInfo.textContent = `${cachedImagesCount} image${cachedImagesCount === 1 ? '' : 's'} (${formattedSize})`;
        }
    } catch (error) {
        const sizeInfo = document.getElementById('markdown-size-info');
        if (sizeInfo) {
            sizeInfo.textContent = 'Could not load size';
        }
    }
}

let cachedNotesSize = 0;
let cachedNotesCount = 0;

async function loadNotesSizeForBackup() {
    try {
        const response = await fetch(`${API_URL}/api/notes/stats`);
        const stats = await response.json();
        cachedNotesSize = stats.totalSize || 0;
        cachedNotesCount = stats.count || 0;

        const sizeInfo = document.getElementById('notes-size-info');
        if (sizeInfo) {
            const formattedSize = formatBackupSize(cachedNotesSize);
            sizeInfo.textContent = `${cachedNotesCount} note${cachedNotesCount === 1 ? '' : 's'} (${formattedSize})`;
        }
    } catch (error) {
        const sizeInfo = document.getElementById('notes-size-info');
        if (sizeInfo) {
            sizeInfo.textContent = 'Could not load size';
        }
    }
}

async function loadArchiveSizeForBackup() {
    try {
        const response = await fetch(`${API_URL}/api/patterns/archived`);
        const archived = await response.json();
        cachedArchiveCount = archived.length || 0;
        cachedArchiveSize = archived.reduce((sum, p) => sum + (p.fileSize || 0), 0);

        const sizeInfo = document.getElementById('archive-size-info');
        if (sizeInfo) {
            const formattedSize = formatBackupSize(cachedArchiveSize);
            sizeInfo.textContent = `${cachedArchiveCount} pattern${cachedArchiveCount === 1 ? '' : 's'} (${formattedSize})`;
        }
    } catch (error) {
        const sizeInfo = document.getElementById('archive-size-info');
        if (sizeInfo) {
            sizeInfo.textContent = 'Could not load archive size';
        }
    }
}

function updateBackupEstimate() {
    const estimate = document.getElementById('backup-estimate');
    if (!estimate) return;

    const includePatterns = document.getElementById('backup-include-patterns');
    const includeMarkdown = document.getElementById('backup-include-markdown');
    const includeArchive = document.getElementById('backup-include-archive');
    const dbEstimate = 50000; // ~50KB for database JSON

    let totalSize = dbEstimate;
    if (includePatterns && includePatterns.checked) {
        totalSize += cachedLibrarySize;
    }
    // Images are included with markdown patterns
    if (includeMarkdown && includeMarkdown.checked) {
        totalSize += cachedImagesSize;
    }
    if (includeArchive && includeArchive.checked) {
        totalSize += cachedArchiveSize;
    }

    estimate.textContent = `Estimated backup size: ${formatBackupSize(totalSize)}`;
}

async function runPrune(setting) {
    if (!setting || setting === 'disabled') return;

    const [mode, value] = setting.split('-');
    try {
        const response = await fetch(`${API_URL}/api/backups/prune`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, value })
        });

        if (response.ok) {
            const result = await response.json();
            if (result.deleted > 0) {
                loadBackups();
            }
        }
    } catch (error) {
        console.error('Error pruning backups:', error);
    }
}

function renderCategoriesList() {
    const categoriesList = document.getElementById('categories-list');
    if (!categoriesList) return;

    const currentDefault = getDefaultCategory();
    categoriesList.innerHTML = allCategories.map(category => {
        const patternCount = populatedCategories.find(c => c.name === category)?.count || 0;
        const isDefault = category === currentDefault;
        return `
            <div class="category-item ${isDefault ? 'is-default' : ''}" data-category="${escapeHtml(category)}">
                <div class="category-info">
                    <span class="category-name">${escapeHtml(category)}</span>
                    ${isDefault ? '<span class="default-badge">Default</span>' : ''}
                </div>
                <span class="category-count">${patternCount} pattern${patternCount !== 1 ? 's' : ''}</span>
                <div class="category-actions">
                    ${isDefault ? `<button class="btn btn-small btn-secondary star-active" title="Default category">★</button>` : `<button class="btn btn-small btn-secondary" onclick="setDefaultCategory('${escapeHtml(category)}')" title="Set as default">★</button>`}
                    <button class="btn btn-small btn-secondary" onclick="startCategoryEdit(this.closest('.category-item'))">Edit</button>
                    <button class="btn btn-small btn-danger" onclick="deleteCategory(this, '${escapeHtml(category)}', ${patternCount})">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

async function addCategory() {
    const input = document.getElementById('new-category-input');
    const name = input.value.trim();

    if (!name) return;

    if (allCategories.includes(name)) {
        alert('Category already exists');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/categories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to add category');
        }

        input.value = '';
        await loadCategories();
        showToast('Category added');
    } catch (error) {
        console.error('Error adding category:', error);
        alert(error.message);
    }
}

function startCategoryEdit(item) {
    const nameSpan = item.querySelector('.category-name');
    const oldName = item.dataset.category;

    // Don't start if already editing
    if (nameSpan.isContentEditable) return;

    nameSpan.contentEditable = true;
    nameSpan.classList.add('editing');
    nameSpan.focus();

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(nameSpan);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const saveEdit = async () => {
        const newName = nameSpan.textContent.trim();
        nameSpan.contentEditable = false;
        nameSpan.classList.remove('editing');

        if (!newName || newName === oldName) {
            nameSpan.textContent = oldName;
            return;
        }

        if (allCategories.includes(newName)) {
            showToast('Category already exists');
            nameSpan.textContent = oldName;
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/categories/${encodeURIComponent(oldName)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to update category');
            }

            await loadCategories();
            await loadPatterns();
            showToast('Category renamed');
        } catch (error) {
            console.error('Error updating category:', error);
            nameSpan.textContent = oldName;
            showToast(error.message);
        }
    };

    const handleKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            nameSpan.blur();
        } else if (e.key === 'Escape') {
            nameSpan.textContent = oldName;
            nameSpan.blur();
        }
    };

    nameSpan.addEventListener('keydown', handleKeydown);
    nameSpan.addEventListener('blur', saveEdit, { once: true });
}

async function deleteCategory(btn, name, patternCount) {
    if (patternCount > 0) {
        alert(`Cannot delete "${name}" because it contains ${patternCount} pattern${patternCount !== 1 ? 's' : ''}. Move or delete the patterns first.`);
        return;
    }

    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm';
        return;
    }

    // Second click - delete
    try {
        const response = await fetch(`${API_URL}/api/categories/${encodeURIComponent(name)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete category');
        }

        await loadCategories();
        showToast('Category deleted');
    } catch (error) {
        console.error('Error deleting category:', error);
        alert(error.message);
    }
}

// Hashtag management functions
function renderHashtagsList() {
    const hashtagsList = document.getElementById('hashtags-list');
    if (!hashtagsList) return;

    if (allHashtags.length === 0) {
        hashtagsList.innerHTML = '<p class="empty-state-small">No hashtags yet. Add one below!</p>';
        return;
    }

    hashtagsList.innerHTML = allHashtags.map(hashtag => `
        <div class="hashtag-item" data-hashtag-id="${hashtag.id}">
            <span class="hashtag-name">#${escapeHtml(hashtag.name)}</span>
            <div class="hashtag-actions">
                <button class="btn btn-small btn-secondary" onclick="startHashtagEdit(this.closest('.hashtag-item'))">Edit</button>
                <button class="btn btn-small btn-danger" onclick="deleteHashtag(this, ${hashtag.id})">Delete</button>
            </div>
        </div>
    `).join('');
}

async function addHashtag() {
    const input = document.getElementById('new-hashtag-input');
    let name = input.value.trim().replace(/^#/, '').toLowerCase();

    if (!name) return;

    if (allHashtags.some(h => h.name === name)) {
        alert('Hashtag already exists');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/hashtags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to add hashtag');
        }

        input.value = '';
        await loadHashtags();
        showToast('Hashtag added');
    } catch (error) {
        console.error('Error adding hashtag:', error);
        alert(error.message);
    }
}

function startHashtagEdit(item) {
    const nameSpan = item.querySelector('.hashtag-name');
    const id = parseInt(item.dataset.hashtagId);
    const oldName = nameSpan.textContent.replace(/^#/, '');

    // Don't start if already editing
    if (nameSpan.isContentEditable) return;

    // Remove the # prefix for editing
    nameSpan.textContent = oldName;
    nameSpan.contentEditable = true;
    nameSpan.classList.add('editing');
    nameSpan.focus();

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(nameSpan);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const saveEdit = async () => {
        let newName = nameSpan.textContent.trim().replace(/^#/, '').toLowerCase();
        nameSpan.contentEditable = false;
        nameSpan.classList.remove('editing');

        // Restore # prefix
        nameSpan.textContent = '#' + (newName || oldName);

        if (!newName || newName === oldName) {
            return;
        }

        if (allHashtags.some(h => h.name === newName && h.id !== id)) {
            showToast('Hashtag already exists');
            nameSpan.textContent = '#' + oldName;
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/hashtags/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to update hashtag');
            }

            await loadHashtags();
            showToast('Hashtag renamed');
        } catch (error) {
            console.error('Error updating hashtag:', error);
            nameSpan.textContent = '#' + oldName;
            showToast(error.message);
        }
    };

    const handleKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            nameSpan.blur();
        } else if (e.key === 'Escape') {
            nameSpan.textContent = oldName;
            nameSpan.blur();
        }
    };

    nameSpan.addEventListener('keydown', handleKeydown);
    nameSpan.addEventListener('blur', saveEdit, { once: true });
}

async function deleteHashtag(btn, id) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm';
        return;
    }

    // Second click - delete
    try {
        const response = await fetch(`${API_URL}/api/hashtags/${id}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete hashtag');
        }

        await loadHashtags();
        showToast('Hashtag deleted');
    } catch (error) {
        console.error('Error deleting hashtag:', error);
        alert(error.message);
    }
}

// Create hashtag selector for forms
function createHashtagSelector(id, selectedHashtagIds = [], disabled = false) {
    return `
        <div class="hashtag-selector ${disabled ? 'disabled' : ''}" data-id="${id}">
            <div class="hashtag-selector-tags" id="hashtag-tags-${id}">
                ${!disabled ? `
                    <div class="hashtag-add-inline">
                        <input type="text" placeholder="Add new"
                               onkeydown="handleNewHashtagInline(event, '${id}')"
                               onclick="event.stopPropagation()">
                    </div>
                ` : ''}
                ${allHashtags.map(h => `
                    <label class="hashtag-tag ${selectedHashtagIds.includes(h.id) ? 'selected' : ''}">
                        <input type="checkbox" value="${h.id}"
                               ${selectedHashtagIds.includes(h.id) ? 'checked' : ''}
                               ${disabled ? 'disabled' : ''}
                               onchange="toggleHashtagSelection('${id}', ${h.id}, this.checked)">
                        <span>#${escapeHtml(h.name)}</span>
                    </label>
                `).join('')}
            </div>
            ${allHashtags.length === 0 && disabled ? '<p class="hashtag-empty">No hashtags available.</p>' : ''}
        </div>
    `;
}

async function handleNewHashtagInline(event, selectorId) {
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const input = event.target;
    let name = input.value.trim().replace(/^#/, '').toLowerCase();

    if (!name) return;

    if (allHashtags.some(h => h.name === name)) {
        alert('Hashtag already exists');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/hashtags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to add hashtag');
        }

        const newHashtag = await response.json();

        // Reload hashtags
        await loadHashtags();

        // Get current selections and add the new one
        const currentSelections = getSelectedHashtagIds(selectorId);
        currentSelections.push(newHashtag.id);

        // Re-render the selector with new hashtag selected
        const selector = document.querySelector(`.hashtag-selector[data-id="${selectorId}"]`);
        if (selector) {
            selector.outerHTML = createHashtagSelector(selectorId, currentSelections, false);
        }

        // Auto-save for edit modal
        if (selectorId === 'edit-hashtags' && editingPatternId) {
            await fetch(`${API_URL}/api/patterns/${editingPatternId}/hashtags`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hashtagIds: currentSelections })
            });
        }
    } catch (error) {
        console.error('Error adding hashtag:', error);
        alert(error.message);
    }
}

async function toggleHashtagSelection(selectorId, hashtagId, isSelected) {
    const selector = document.querySelector(`.hashtag-selector[data-id="${selectorId}"]`);
    if (!selector) return;

    // Update visual state
    const label = selector.querySelector(`input[value="${hashtagId}"]`).parentElement;
    label.classList.toggle('selected', isSelected);

    // Auto-save for edit modals
    if (selectorId === 'edit-hashtags' && editingPatternId) {
        const hashtagIds = getSelectedHashtagIds(selectorId);
        await fetch(`${API_URL}/api/patterns/${editingPatternId}/hashtags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashtagIds })
        });
    }

    // Trigger callback for staged files
    const event = new CustomEvent('hashtagchange', {
        detail: { id: selectorId, hashtagId, isSelected }
    });
    selector.dispatchEvent(event);
}

function getSelectedHashtagIds(selectorId) {
    const selector = document.querySelector(`.hashtag-selector[data-id="${selectorId}"]`);
    if (!selector) return [];

    const checkboxes = selector.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.value));
}

function initLibraryFilters() {
    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('search-clear-btn');
    const mobileSearchInput = document.getElementById('mobile-search-input');
    const mobileSearchClearBtn = document.getElementById('mobile-search-clear-btn');
    const sortSelect = document.getElementById('sort-select');
    const showCompletedCheckbox = document.getElementById('show-completed');
    const showCurrentCheckbox = document.getElementById('show-current');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase();
            displayPatterns();
            if (searchClearBtn) {
                searchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            }
        });
    }

    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            searchInput.value = '';
            if (mobileSearchInput) mobileSearchInput.value = '';
            searchQuery = '';
            searchClearBtn.classList.remove('visible');
            if (mobileSearchClearBtn) mobileSearchClearBtn.classList.remove('visible');
            displayPatterns();
            searchInput.focus();
        });
    }

    // Filter by hashtag (called when clicking a tag on a card)
    window.filterByHashtag = function(tagName, tab) {
        const query = `#${tagName}`;

        if (tab === 'projects') {
            // Switch to projects tab and filter there
            switchToTab('projects');
            projectSearchQuery = query.toLowerCase();
            const projSearch = document.getElementById('project-search-input');
            const projClear = document.getElementById('project-search-clear-btn');
            const projMobileSearch = document.getElementById('project-mobile-search-input');
            const projMobileClear = document.getElementById('project-mobile-search-clear-btn');
            if (projSearch) { projSearch.value = query; }
            if (projClear) projClear.classList.add('visible');
            if (projMobileSearch) { projMobileSearch.value = query; }
            if (projMobileClear) projMobileClear.classList.add('visible');
            displayProjects();
        } else {
            // Default: switch to library tab and filter there
            switchToTab('library');
            searchQuery = query.toLowerCase();
            if (searchInput) {
                searchInput.value = query;
                if (searchClearBtn) searchClearBtn.classList.add('visible');
            }
            if (mobileSearchInput) {
                mobileSearchInput.value = query;
                if (mobileSearchClearBtn) mobileSearchClearBtn.classList.add('visible');
            }
            displayPatterns();
        }
    };

    if (sortSelect) {
        // Restore saved sort value
        sortSelect.value = selectedSort;
        sortSelect.addEventListener('change', (e) => {
            selectedSort = e.target.value;
            localStorage.setItem('librarySort', selectedSort);
            displayPatterns();
        });
    }

    if (showCompletedCheckbox) {
        // Restore saved checkbox state
        showCompletedCheckbox.checked = showCompleted;
        showCompletedCheckbox.addEventListener('change', (e) => {
            showCompleted = e.target.checked;
            localStorage.setItem('libraryShowCompleted', showCompleted);
            displayPatterns();
        });
    }

    if (showCurrentCheckbox) {
        // Restore saved checkbox state
        showCurrentCheckbox.checked = showCurrent;
        showCurrentCheckbox.addEventListener('change', (e) => {
            showCurrent = e.target.checked;
            localStorage.setItem('libraryShowCurrent', showCurrent);
            displayPatterns();
        });
    }

    const showPdfCheckbox = document.getElementById('show-pdf');
    const showMarkdownCheckbox = document.getElementById('show-markdown');

    if (showPdfCheckbox) {
        // Restore saved checkbox state
        showPdfCheckbox.checked = showPdf;
        showPdfCheckbox.addEventListener('change', (e) => {
            showPdf = e.target.checked;
            localStorage.setItem('libraryShowPdf', showPdf);
            displayPatterns();
        });
    }

    if (showMarkdownCheckbox) {
        // Restore saved checkbox state
        showMarkdownCheckbox.checked = showMarkdown;
        showMarkdownCheckbox.addEventListener('change', (e) => {
            showMarkdown = e.target.checked;
            localStorage.setItem('libraryShowMarkdown', showMarkdown);
            displayPatterns();
        });
    }

    const highlightSelect = document.getElementById('highlight-select');
    if (highlightSelect) {
        highlightSelect.value = highlightMode;
        highlightSelect.addEventListener('change', (e) => {
            highlightMode = e.target.value;
            localStorage.setItem('libraryHighlightMode', highlightMode);
            displayPatterns();
        });
    }

    // Pin buttons
    const pinCurrentBtn = document.getElementById('pin-current');
    const pinFavoritesBtn = document.getElementById('pin-favorites');

    if (pinCurrentBtn) {
        if (pinCurrent) pinCurrentBtn.classList.add('active');
        pinCurrentBtn.addEventListener('click', () => {
            pinCurrent = !pinCurrent;
            pinCurrentBtn.classList.toggle('active', pinCurrent);
            localStorage.setItem('libraryPinCurrent', pinCurrent);
            displayPatterns();
        });
    }

    if (pinFavoritesBtn) {
        if (pinFavorites) pinFavoritesBtn.classList.add('active');
        pinFavoritesBtn.addEventListener('click', () => {
            pinFavorites = !pinFavorites;
            pinFavoritesBtn.classList.toggle('active', pinFavorites);
            localStorage.setItem('libraryPinFavorites', pinFavorites);
            displayPatterns();
        });
    }

    // Show filter dropdown
    const showFilterSelect = document.getElementById('show-filter-select');
    if (showFilterSelect) {
        showFilterSelect.value = showFilter;
        showFilterSelect.addEventListener('change', (e) => {
            showFilter = e.target.value;
            localStorage.setItem('libraryShowFilter', showFilter);
            displayPatterns();
        });
    }

    // Rating filter dropdown
    const ratingFilterSelect = document.getElementById('rating-filter-select');
    if (ratingFilterSelect) {
        ratingFilterSelect.value = ratingFilter;
        ratingFilterSelect.addEventListener('change', (e) => {
            ratingFilter = e.target.value;
            localStorage.setItem('libraryRatingFilter', ratingFilter);
            displayPatterns();
        });
    }

    // Owner filter dropdown (admin only)
    const ownerFilterSection = document.getElementById('owner-filter-section');
    const ownerFilterSelect = document.getElementById('owner-filter-select');
    if (currentUser?.role === 'admin' && ownerFilterSection) {
        ownerFilterSection.style.display = '';
        if (ownerFilterSelect) {
            ownerFilterSelect.value = ownerFilter;
            ownerFilterSelect.addEventListener('change', (e) => {
                ownerFilter = e.target.value;
                localStorage.setItem('libraryOwnerFilter', ownerFilter);
                displayPatterns();
            });
        }
    }

    // Mobile filter bar
    const mobileFilterBtn = document.getElementById('mobile-filter-btn');

    if (mobileFilterBtn) {
        mobileFilterBtn.addEventListener('click', () => {
            const sidebar = document.querySelector('.library-sidebar');
            if (sidebar) {
                sidebar.classList.toggle('mobile-visible');
                mobileFilterBtn.classList.toggle('active', sidebar.classList.contains('mobile-visible'));
            }
        });
    }

    if (mobileSearchInput) {
        mobileSearchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase();
            if (searchInput) searchInput.value = e.target.value;
            if (searchClearBtn) searchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            if (mobileSearchClearBtn) mobileSearchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            displayPatterns();
        });

        // Sync desktop search → mobile search
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                mobileSearchInput.value = searchInput.value;
                if (mobileSearchClearBtn) mobileSearchClearBtn.classList.toggle('visible', searchInput.value.length > 0);
            });
        }
    }

    if (mobileSearchClearBtn) {
        mobileSearchClearBtn.addEventListener('click', () => {
            mobileSearchInput.value = '';
            if (searchInput) searchInput.value = '';
            searchQuery = '';
            mobileSearchClearBtn.classList.remove('visible');
            if (searchClearBtn) searchClearBtn.classList.remove('visible');
            displayPatterns();
            mobileSearchInput.focus();
        });
    }

    // Desktop sidebar toggle
    const libToggleBtn = document.getElementById('library-sidebar-toggle');
    if (libToggleBtn) {
        const libraryLayout = document.getElementById('library-layout');
        if (libraryLayout.classList.contains('sidebar-collapsed')) libToggleBtn.classList.add('active');
        libToggleBtn.addEventListener('click', () => {
            const isCollapsed = libraryLayout.classList.toggle('sidebar-collapsed');
            libToggleBtn.classList.toggle('active', isCollapsed);
            localStorage.setItem('librarySidebarCollapsed', isCollapsed);
        });
    }

    // Library view toggle (card/list)
    document.querySelectorAll('#library-view-toggle .view-toggle-btn, #library-mobile-view-toggle .view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            libraryView = btn.dataset.view;
            localStorage.setItem('libraryView', libraryView);
            document.querySelectorAll('#library-view-toggle .view-toggle-btn, #library-mobile-view-toggle .view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === libraryView));
            exitLibraryEditMode();
            clearBulkSelection();
            displayPatterns();
        });
    });
}

function renderPatternCard(pattern, options = {}) {
    const { highlightClass = '' } = options;

    const hashtags = pattern.hashtags || [];
    const hashtagsHtml = hashtags.length > 0
        ? `<div class="pattern-hashtags">${hashtags.map(h => `<span class="pattern-hashtag" onclick="event.stopPropagation(); filterByHashtag('${escapeHtml(h.name)}')">#${escapeHtml(h.name)}</span>`).join('')}</div>`
        : '';

    const typeLabel = pattern.pattern_type === 'markdown' ? 'MD' : 'PDF';
    const isAdmin = currentUser?.role === 'admin';
    const isOwnPattern = !isAdmin || pattern.user_id === currentUser?.id;
    const ownerName = pattern.owner_display_name || pattern.owner_username;

    const isSelected = selectedPatternIds.has(pattern.id);
    return `
        <div class="pattern-card${highlightClass}${isSelected ? ' bulk-selected' : ''}" onclick="handlePatternClick(event, ${pattern.id})" data-pattern-id="${pattern.id}">
            <div class="bulk-select-checkbox" onclick="event.stopPropagation(); toggleBulkSelect(${pattern.id}, this)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            ${isOwnPattern && showStatusBadge && pattern.completed ? '<span class="completed-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
            ${isOwnPattern && showStatusBadge && !pattern.completed && pattern.is_current ? '<span class="current-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span>' : ''}
            ${showCategoryBadge && pattern.category ? `<span class="category-badge-overlay">${escapeHtml(pattern.category)}</span>` : ''}
            ${!isOwnPattern && ownerName ? `<span class="owner-badge-overlay" style="background:${userColor(ownerName)}">${escapeHtml(ownerName)}</span>` : (showTypeBadge ? `<span class="type-badge">${typeLabel}</span>` : '')}
            ${showRatingBadge && pattern.rating ? `<span class="rating-badge">${ratingBadgeHtml(pattern.rating)}</span>` : ''}
            ${isOwnPattern && showStarBadge && pattern.is_favorite ? '<span class="favorite-badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></span>' : ''}
            ${pattern.thumbnail
                ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" class="pattern-thumbnail" alt="${escapeHtml(pattern.name)}">`
                : `<div class="pattern-thumbnail-placeholder">
                    <img src="${API_URL}/icons/crocheting.svg" width="100" height="100" alt="">
                  </div>`}
            <h3 title="${escapeHtml(pattern.name)}">${escapeHtml(pattern.name)}</h3>
            ${pattern.completed && pattern.completed_date
                ? `<p class="completion-date">${new Date(pattern.completed_date).toLocaleDateString()}${pattern.timer_seconds > 0 ? ` · ${formatTime(pattern.timer_seconds)}` : ''}</p>`
                : (pattern.timer_seconds > 0
                    ? `<p class="pattern-status elapsed">Elapsed: ${formatTime(pattern.timer_seconds)}</p>`
                    : `<p class="pattern-status new">New Pattern</p>`)}
            <p class="pattern-description" onclick="event.stopPropagation(); startInlineDescEdit(this, '${pattern.id}')" title="Click to edit">${pattern.description ? escapeHtml(pattern.description) : '<span class="add-description">+ Add description</span>'}</p>
            ${hashtagsHtml}
            <div class="pattern-actions" onclick="event.stopPropagation()">
                <button class="action-btn ${pattern.is_current ? 'current' : ''}"
                        onclick="toggleCurrent('${pattern.id}', ${!pattern.is_current})"
                        title="${pattern.is_current ? 'Remove from In Progress' : 'Mark In Progress'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${pattern.is_current ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                </button>
                <button class="action-btn ${pattern.is_favorite ? 'active favorite' : ''}"
                        onclick="toggleFavorite('${pattern.id}', ${!pattern.is_favorite})"
                        title="${pattern.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${pattern.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>
                </button>
                <button class="action-btn ${pattern.completed ? 'completed' : ''}"
                        onclick="toggleComplete('${pattern.id}', ${!pattern.completed})"
                        title="${pattern.completed ? 'Mark Incomplete' : 'Mark Complete'}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10" ${pattern.completed ? 'fill="currentColor"' : ''}></circle>
                        <polyline points="16 8 10 16 7 13" ${pattern.completed ? 'stroke="var(--card-bg, #1a1a2e)"' : ''}></polyline>
                    </svg>
                </button>
                <button class="action-btn" onclick="openEditModal('${pattern.id}')" title="Edit">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </button>
                <button class="action-btn ${enableDirectDelete ? 'delete' : 'archive'}" onclick="handleCardDelete(this, '${pattern.id}')" title="${enableDirectDelete ? 'Delete' : 'Archive'}">
                    <svg class="trash-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    <svg class="archive-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="21 8 21 21 3 21 3 8"></polyline>
                        <rect x="1" y="3" width="22" height="5"></rect>
                        <line x1="10" y1="12" x2="14" y2="12"></line>
                    </svg>
                    <svg class="confirm-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

function displayCurrentPatterns() {
    const grid = document.getElementById('current-patterns-grid');

    const hasPatterns = currentPatterns.length > 0;
    const hasProjects = currentProjects.length > 0;

    if (!hasPatterns && !hasProjects) {
        grid.innerHTML = '<p class="empty-state">You don\'t have any active patterns or projects. Time to start crocheting!</p>';
        return;
    }

    // Render current projects first, then current patterns
    const projectCards = currentProjects.map(project => renderProjectCard(project)).join('');
    const patternCards = currentPatterns.map(pattern => renderPatternCard(pattern)).join('');

    grid.innerHTML = projectCards + patternCards;
    grid.querySelectorAll('.pattern-card[data-pattern-id]').forEach(initLongPress);
}

function displayPatterns() {
    const grid = document.getElementById('patterns-grid');

    if (patterns.length === 0) {
        grid.innerHTML = '<p class="empty-state">No patterns yet. Upload your first pattern!</p>';
        return;
    }

    // Filter patterns by search query (including hashtags)
    let filteredPatterns = patterns;
    if (searchQuery) {
        const isHashtagSearch = searchQuery.startsWith('#');
        const searchTerm = searchQuery.replace(/^#/, '').toLowerCase();

        filteredPatterns = filteredPatterns.filter(p => {
            if (isHashtagSearch) {
                // Only search hashtags when query starts with #
                return p.hashtags && p.hashtags.some(h => h.name.toLowerCase().includes(searchTerm));
            } else {
                // Search name, description, and hashtags
                if (p.name.toLowerCase().includes(searchTerm)) return true;
                if (p.description && p.description.toLowerCase().includes(searchTerm)) return true;
                if (p.hashtags && p.hashtags.some(h => h.name.toLowerCase().includes(searchTerm))) return true;
                return false;
            }
        });
    }

    // Filter patterns by selected category
    filteredPatterns = selectedCategoryFilter === 'all'
        ? filteredPatterns
        : filteredPatterns.filter(p => p.category === selectedCategoryFilter);

    // Filter by show completed/current checkboxes
    filteredPatterns = filteredPatterns.filter(p => {
        if (p.completed && !showCompleted) return false;
        if (p.is_current && !p.completed && !showCurrent) return false;
        return true;
    });

    // Filter by pattern type (PDF/Markdown)
    filteredPatterns = filteredPatterns.filter(p => {
        const isPdf = p.pattern_type !== 'markdown';
        if (isPdf && !showPdf) return false;
        if (!isPdf && !showMarkdown) return false;
        return true;
    });

    // Filter by show dropdown (favorites/current/new)
    if (showFilter !== 'all') {
        filteredPatterns = filteredPatterns.filter(p => {
            if (showFilter === 'favorites') return p.is_favorite;
            if (showFilter === 'current') return p.is_current && !p.completed;
            if (showFilter === 'new') return !p.completed && !p.timer_seconds;
            return true;
        });
    }

    // Filter by rating
    if (ratingFilter !== 'all') {
        filteredPatterns = filteredPatterns.filter(p => {
            if (ratingFilter === 'rated') return p.rating > 0;
            if (ratingFilter === 'unrated') return !p.rating;
            return (p.rating || 0) === parseInt(ratingFilter);
        });
    }

    // Filter by owner (admin only)
    if (currentUser?.role === 'admin' && ownerFilter !== 'all') {
        if (ownerFilter === 'mine') {
            filteredPatterns = filteredPatterns.filter(p => p.user_id === currentUser.id);
        } else {
            const ownerId = parseInt(ownerFilter);
            filteredPatterns = filteredPatterns.filter(p => p.user_id === ownerId);
        }
    }

    // Sort patterns
    if (libraryView === 'list') {
        // List view: sort by column header
        filteredPatterns = sortPatternList(filteredPatterns, patternListSort);
    } else {
        // Card view: sort by sidebar selection with pin support
        filteredPatterns = [...filteredPatterns].sort((a, b) => {
            if (pinFavorites && a.is_favorite !== b.is_favorite) {
                return b.is_favorite ? 1 : -1;
            }
            if (pinCurrent && a.is_current !== b.is_current) {
                return b.is_current ? 1 : -1;
            }
            switch (selectedSort) {
                case 'date-desc':
                    return new Date(b.upload_date) - new Date(a.upload_date);
                case 'date-asc':
                    return new Date(a.upload_date) - new Date(b.upload_date);
                case 'opened-desc':
                    return (new Date(b.last_opened_at || 0)) - (new Date(a.last_opened_at || 0));
                case 'opened-asc':
                    return (new Date(a.last_opened_at || 0)) - (new Date(b.last_opened_at || 0));
                case 'name-asc':
                    return a.name.localeCompare(b.name);
                case 'name-desc':
                    return b.name.localeCompare(a.name);
                case 'rating-desc':
                    return (b.rating || 0) - (a.rating || 0);
                case 'rating-asc':
                    return (a.rating || 0) - (b.rating || 0);
                default:
                    return 0;
            }
        });
    }

    if (filteredPatterns.length === 0) {
        grid.innerHTML = `<p class="empty-state">No patterns match the current filters</p>`;
        return;
    }

    // Remove early view styles once JS takes over
    const earlyViewStyle2 = document.getElementById('early-view-style');
    if (earlyViewStyle2) earlyViewStyle2.remove();
    // Toggle sidebar visibility based on view
    const sidebarToggle = document.getElementById('library-sidebar-toggle');
    if (sidebarToggle) sidebarToggle.style.display = libraryView === 'list' ? 'none' : '';
    const mobileFilterBtn2 = document.getElementById('mobile-filter-btn');
    if (mobileFilterBtn2) mobileFilterBtn2.style.display = libraryView === 'list' ? 'none' : '';
    if (libraryView === 'list') {
        const sidebar = document.querySelector('.library-sidebar');
        if (sidebar) sidebar.classList.remove('mobile-visible');
        if (mobileFilterBtn2) mobileFilterBtn2.classList.remove('active');
    }
    const libraryLayout = document.getElementById('library-layout');
    if (libraryLayout) libraryLayout.classList.toggle('library-list-view', libraryView === 'list');

    if (libraryView === 'list') {
        const cols = getColumnOrder('pattern');
        const arrow = (col) => patternListSort.col === col ? (patternListSort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span style="visibility:hidden">▲</span>';
        const cbStyle = 'style="width:40px;min-width:40px;padding:8px 6px;text-align:center"';
        const cbTh = libraryEditMode ? `<th ${cbStyle}></th>` : '';
        const cbTd = (p) => libraryEditMode ? `<td ${cbStyle}><div class="bulk-select-checkbox" onclick="event.stopPropagation(); togglePatternRowSelect(${p.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div></td>` : '';
        grid.className = 'inventory-list-wrap';
        grid.innerHTML = `<table class="inventory-table" data-type="pattern">
            <thead><tr>${cbTh}${cols.map(c => `<th data-col="${c}"${c === 'thumbnail' ? ' class="col-thumbnail"' : ''} draggable="true" onclick="togglePatternListSort('${c}')" oncontextmenu="showColumnMenu(event,'pattern')" ondragstart="onColDragStart(event)" ondragend="onColDragEnd(event)" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,'pattern')">${PATTERN_COLUMNS[c].label}${c === 'thumbnail' ? '' : arrow(c)}</th>`).join('')}</tr></thead>
            <tbody>${filteredPatterns.map(p => `<tr onclick="handlePatternRowClick(event,${p.id})" oncontextmenu="showRowMenu(event,'pattern',${p.id})" class="${selectedPatternIds.has(p.id) ? 'bulk-selected' : ''}" data-pattern-id="${p.id}">${cbTd(p)}${cols.map(c => `<td${c === 'thumbnail' ? ' class="col-thumbnail"' : ''}>${PATTERN_COLUMNS[c].value(p)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>`;
        initListRowLongPress('pattern');
    } else {
        grid.className = 'patterns-grid' + (libraryEditMode ? ' bulk-edit-mode' : '');
        grid.innerHTML = filteredPatterns.map(pattern => {
            const isNewPattern = !pattern.completed && !pattern.timer_seconds;
            const shouldHighlight = (highlightMode === 'new' && isNewPattern) || (highlightMode === 'current' && pattern.is_current) || (highlightMode === 'favorites' && pattern.is_favorite);
            const highlightClass = shouldHighlight ? ' highlight-new' : '';
            return renderPatternCard(pattern, { highlightClass });
        }).join('');
        grid.querySelectorAll('.pattern-card[data-pattern-id]').forEach(initLongPress);
    }
}

async function toggleCurrent(id, isCurrent) {
    // Optimistic update
    const pattern = patterns.find(p => String(p.id) === String(id));
    if (pattern) {
        pattern.is_current = isCurrent;
        if (isCurrent && !pattern.started_date) {
            pattern.started_date = new Date().toISOString();
        }
        // Also update currentPatterns array so the In Progress page reflects the change
        if (isCurrent) {
            if (!currentPatterns.find(p => String(p.id) === String(id))) {
                currentPatterns.unshift(pattern);
            }
        } else {
            currentPatterns = currentPatterns.filter(p => String(p.id) !== String(id));
        }
        displayCurrentPatterns();
        displayPatterns();
        updateTabCounts();
    }
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/current`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isCurrent })
        });

        if (!response.ok) {
            // Revert on failure
            if (pattern) pattern.is_current = !isCurrent;
            await loadPatterns();
            await loadCurrentPatterns();
        }
    } catch (error) {
        console.error('Error toggling current status:', error);
        if (pattern) pattern.is_current = !isCurrent;
        await loadPatterns();
        await loadCurrentPatterns();
    }
}

async function toggleComplete(id, completed) {
    // Optimistic update
    const pattern = patterns.find(p => String(p.id) === String(id));
    if (pattern) {
        pattern.completed = completed;
        if (completed && !pattern.completed_date) {
            pattern.completed_date = new Date().toISOString();
        } else if (!completed) {
            pattern.completed_date = null;
        }
        // Update currentPatterns: completed patterns leave in-progress, uncompleted+current ones rejoin
        const inCurrent = currentPatterns.find(p => String(p.id) === String(id));
        if (completed && inCurrent) {
            currentPatterns = currentPatterns.filter(p => String(p.id) !== String(id));
        } else if (!completed && pattern.is_current && !inCurrent) {
            currentPatterns.push(pattern);
        }
        displayCurrentPatterns();
        displayPatterns();
        updateTabCounts();
    }
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/complete`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed })
        });

        if (!response.ok) {
            if (pattern) pattern.completed = !completed;
            await loadPatterns();
            await loadCurrentPatterns();
        }
    } catch (error) {
        console.error('Error toggling completion status:', error);
        if (pattern) pattern.completed = !completed;
        await loadPatterns();
        await loadCurrentPatterns();
    }
}

async function toggleFavorite(id, isFavorite) {
    // Optimistic update
    const pattern = patterns.find(p => String(p.id) === String(id));
    if (pattern) pattern.is_favorite = isFavorite;
    const currentPattern = currentPatterns.find(p => String(p.id) === String(id));
    if (currentPattern) currentPattern.is_favorite = isFavorite;
    displayCurrentPatterns();
    displayPatterns();
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/favorite`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });

        if (!response.ok) {
            if (pattern) pattern.is_favorite = !isFavorite;
            await loadPatterns();
            await loadCurrentPatterns();
        }
    } catch (error) {
        console.error('Error toggling favorite status:', error);
        if (pattern) pattern.is_favorite = !isFavorite;
        await loadPatterns();
        await loadCurrentPatterns();
    }
}

async function toggleYarnFavorite(id, isFavorite) {
    const yarn = yarns.find(y => String(y.id) === String(id));
    if (yarn) {
        yarn.is_favorite = isFavorite;
        displayYarns();
    }
    try {
        const response = await fetch(`${API_URL}/api/yarns/${id}/favorite`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });
        if (!response.ok) {
            if (yarn) yarn.is_favorite = !isFavorite;
            displayYarns();
        }
    } catch (error) {
        console.error('Error toggling yarn favorite:', error);
        if (yarn) yarn.is_favorite = !isFavorite;
        displayYarns();
    }
}

async function toggleHookFavorite(id, isFavorite) {
    const hook = hooks.find(h => String(h.id) === String(id));
    if (hook) {
        hook.is_favorite = isFavorite;
        displayHooks();
    }
    try {
        const response = await fetch(`${API_URL}/api/hooks/${id}/favorite`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });
        if (!response.ok) {
            if (hook) hook.is_favorite = !isFavorite;
            displayHooks();
        }
    } catch (error) {
        console.error('Error toggling hook favorite:', error);
        if (hook) hook.is_favorite = !isFavorite;
        displayHooks();
    }
}

async function setPatternRating(id, rating) {
    const p = patterns.find(x => String(x.id) === String(id));
    const cp = currentPatterns.find(x => String(x.id) === String(id));
    const oldRating = p?.rating || 0;
    if (p) p.rating = rating;
    if (cp) cp.rating = rating;
    displayPatterns();
    displayCurrentPatterns();
    try {
        const res = await fetch(`${API_URL}/api/patterns/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        });
        if (!res.ok) { if (p) p.rating = oldRating; if (cp) cp.rating = oldRating; displayPatterns(); displayCurrentPatterns(); }
    } catch { if (p) p.rating = oldRating; if (cp) cp.rating = oldRating; displayPatterns(); displayCurrentPatterns(); }
}

async function setInventoryRating(type, id, rating) {
    const arr = type === 'yarn' ? yarns : hooks;
    const item = arr.find(x => String(x.id) === String(id));
    const oldRating = item?.rating || 0;
    if (item) item.rating = rating;
    if (type === 'yarn') displayYarns(); else displayHooks();
    try {
        const endpoint = type === 'yarn' ? 'yarns' : 'hooks';
        const res = await fetch(`${API_URL}/api/${endpoint}/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        });
        if (!res.ok) { if (item) item.rating = oldRating; if (type === 'yarn') displayYarns(); else displayHooks(); }
    } catch { if (item) item.rating = oldRating; if (type === 'yarn') displayYarns(); else displayHooks(); }
}

function handleCardDelete(btn, id) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.title = enableDirectDelete ? 'Click again to delete' : 'Click again to archive';
        return;
    }

    // Second click - archive or delete based on setting
    if (enableDirectDelete) {
        deletePattern(id);
    } else {
        archivePattern(id);
    }
}

function startInlineDescEdit(element, patternId) {
    // Don't start editing if already editing
    if (element.isContentEditable) return;

    const maxLen = 45;
    const currentText = element.querySelector('.add-description') ? '' : element.textContent;

    element.textContent = currentText;
    element.contentEditable = true;
    element.classList.add('editing');

    // Add character counter (positioned absolutely via CSS)
    const counter = document.createElement('span');
    counter.className = 'inline-char-counter';
    counter.textContent = `${currentText.length}/${maxLen}`;
    element.parentNode.insertBefore(counter, element.nextSibling);

    element.focus();

    // Put cursor at end
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const updateCounter = () => {
        const len = element.textContent.length;
        counter.textContent = `${len}/${maxLen}`;
        counter.classList.toggle('over', len > maxLen);
    };

    const saveDesc = async () => {
        window.getSelection().removeAllRanges();
        element.contentEditable = false;
        element.classList.remove('editing');
        counter.remove();
        const newDesc = element.textContent.trim().substring(0, maxLen);

        // Show placeholder immediately if empty
        if (!newDesc) {
            element.innerHTML = '<span class="add-description">+ Add description</span>';
        }

        try {
            const response = await fetch(`${API_URL}/api/patterns/${patternId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: newDesc })
            });
            if (response.ok) {
                await loadPatterns();
            }
        } catch (error) {
            console.error('Error updating description:', error);
            loadPatterns();
        }
    };

    const handleInput = () => {
        // Enforce max length
        if (element.textContent.length > maxLen) {
            const selection = window.getSelection();
            const cursorPos = selection.focusOffset;
            element.textContent = element.textContent.substring(0, maxLen);
            // Restore cursor
            const range = document.createRange();
            range.setStart(element.firstChild || element, Math.min(cursorPos, maxLen));
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }
        updateCounter();
    };

    const handleKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            element.blur();
        } else if (e.key === 'Escape') {
            element.removeEventListener('blur', handleBlur);
            element.removeEventListener('input', handleInput);
            element.contentEditable = false;
            element.classList.remove('editing');
            counter.remove();
            loadPatterns();
        }
    };

    const handleBlur = () => {
        element.removeEventListener('keydown', handleKeydown);
        element.removeEventListener('input', handleInput);
        saveDesc();
    };

    element.addEventListener('input', handleInput);
    element.addEventListener('keydown', handleKeydown);
    element.addEventListener('blur', handleBlur, { once: true });
}

function startInlineProjectDescEdit(element, projectId) {
    if (element.isContentEditable) return;

    const maxLen = 45;
    const currentText = element.querySelector('.add-description') ? '' : element.textContent;

    element.textContent = currentText;
    element.contentEditable = true;
    element.classList.add('editing');
    element.style.webkitLineClamp = 'unset';

    const counter = document.createElement('span');
    counter.className = 'inline-char-counter';
    counter.textContent = `${currentText.length}/${maxLen}`;
    element.parentNode.insertBefore(counter, element.nextSibling);

    element.focus();

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const updateCounter = () => {
        const len = element.textContent.length;
        counter.textContent = `${len}/${maxLen}`;
        counter.classList.toggle('over', len > maxLen);
    };

    const saveDesc = async () => {
        window.getSelection().removeAllRanges();
        element.contentEditable = false;
        element.classList.remove('editing');
        element.style.webkitLineClamp = '';
        counter.remove();
        const newDesc = element.textContent.trim().substring(0, maxLen);

        if (!newDesc) {
            element.innerHTML = '<span class="add-description">+ Add description</span>';
        }

        try {
            const response = await fetch(`${API_URL}/api/projects/${projectId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: newDesc })
            });
            if (response.ok) {
                await loadProjects();
                await loadCurrentProjects();
                displayCurrentPatterns();
            }
        } catch (error) {
            console.error('Error updating project description:', error);
            loadProjects();
        }
    };

    const handleInput = () => {
        if (element.textContent.length > maxLen) {
            const selection = window.getSelection();
            const cursorPos = selection.focusOffset;
            element.textContent = element.textContent.substring(0, maxLen);
            const r = document.createRange();
            r.setStart(element.firstChild || element, Math.min(cursorPos, maxLen));
            r.collapse(true);
            selection.removeAllRanges();
            selection.addRange(r);
        }
        updateCounter();
    };

    const handleKeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            element.blur();
        } else if (e.key === 'Escape') {
            element.removeEventListener('blur', handleBlur);
            element.removeEventListener('input', handleInput);
            element.contentEditable = false;
            element.classList.remove('editing');
            element.style.webkitLineClamp = '';
            counter.remove();
            loadProjects();
        }
    };

    const handleBlur = () => {
        element.removeEventListener('keydown', handleKeydown);
        element.removeEventListener('input', handleInput);
        saveDesc();
    };

    element.addEventListener('input', handleInput);
    element.addEventListener('keydown', handleKeydown);
    element.addEventListener('blur', handleBlur, { once: true });
}

function resetCardDeleteButtons() {
    document.querySelectorAll('.action-btn.delete.confirm-delete, .action-btn.archive.confirm-delete').forEach(btn => {
        btn.classList.remove('confirm-delete');
        btn.title = btn.classList.contains('archive') ? 'Archive' : 'Delete';
    });
}

function resetArchivedDeleteButtons() {
    document.querySelectorAll('.archived-delete-btn.confirm-delete').forEach(btn => {
        btn.classList.remove('confirm-delete');
        btn.title = 'Delete permanently';
    });
    resetDeleteAllButton();
}

function resetCategoryDeleteButtons() {
    document.querySelectorAll('.category-actions .btn-danger.confirm-delete').forEach(btn => {
        btn.classList.remove('confirm-delete');
        btn.textContent = 'Delete';
    });
}

function resetUserDeleteButtons() {
    document.querySelectorAll('.delete-user-btn.confirm-delete').forEach(btn => {
        btn.classList.remove('confirm-delete');
        btn.textContent = 'Delete';
    });
}

function resetHashtagDeleteButtons() {
    document.querySelectorAll('.hashtag-actions .btn-danger.confirm-delete').forEach(btn => {
        btn.classList.remove('confirm-delete');
        btn.textContent = 'Delete';
    });
}

function resetUploadClearButtons() {
    const clearAllBtn = document.getElementById('clear-all-btn');
    const clearCompletedBtn = document.getElementById('clear-completed-btn');
    if (clearAllBtn && clearAllBtn.classList.contains('confirm-delete')) {
        clearAllBtn.classList.remove('confirm-delete');
        clearAllBtn.textContent = 'Clear All';
    }
    if (clearCompletedBtn && clearCompletedBtn.classList.contains('confirm-delete')) {
        clearCompletedBtn.classList.remove('confirm-delete');
        clearCompletedBtn.textContent = 'Clear';
    }
}

// Reset delete buttons when clicking elsewhere
document.addEventListener('click', (e) => {
    if (!e.target.closest('.action-btn.delete') && !e.target.closest('.action-btn.archive')) {
        resetCardDeleteButtons();
    }
    if (!e.target.closest('.archived-delete-btn') && !e.target.closest('#delete-all-archived-btn')) {
        resetArchivedDeleteButtons();
    }
    if (!e.target.closest('.category-actions .btn-danger')) {
        resetCategoryDeleteButtons();
    }
    if (!e.target.closest('.hashtag-actions .btn-danger')) {
        resetHashtagDeleteButtons();
    }
    if (!e.target.closest('#clear-all-btn') && !e.target.closest('#clear-completed-btn')) {
        resetUploadClearButtons();
    }
    if (!e.target.closest('.delete-user-btn')) {
        resetUserDeleteButtons();
    }
});

function deletePattern(id) {
    const item = patterns.find(p => p.id == id);
    if (!item) return;
    const wasCurrent = currentPatterns.find(p => p.id == id);
    undoableDelete(
        'Pattern deleted',
        () => {
            patterns = patterns.filter(p => p.id != id);
            currentPatterns = currentPatterns.filter(p => p.id != id);
            displayPatterns(); displayCurrentPatterns(); loadCategories();
        },
        async () => { try { await fetch(`${API_URL}/api/patterns/${id}`, { method: 'DELETE' }); } catch(e) { console.error('Error deleting pattern:', e); } },
        () => {
            patterns.push(item);
            if (wasCurrent) currentPatterns.push(item);
            displayPatterns(); displayCurrentPatterns(); loadCategories();
        }
    );
}

async function duplicatePattern(id) {
    try {
        const res = await fetch(`${API_URL}/api/patterns/${id}/duplicate`, { method: 'POST' });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const newPattern = await res.json();
        showToast(`Duplicated as "${newPattern.name}"`);
        await loadPatterns();
        await loadCategories();
        displayPatterns();
    } catch (e) {
        showToast('Failed to duplicate: ' + e.message, 'error');
    }
}

async function copyPatternToAccount(id) {
    try {
        const res = await fetch(`${API_URL}/api/patterns/${id}/copy-to-account`, { method: 'POST' });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const newPattern = await res.json();
        showToast(`Copied "${newPattern.name}" to your account`);
        await loadPatterns();
        await loadCategories();
        displayPatterns();
    } catch (e) {
        showToast('Failed to copy: ' + e.message, 'error');
    }
}

function addPatternsToNewProject(patternIds) {
    clearBulkSelection();
    switchToTab('projects', false);
    showNewProjectPanel();
    // Pre-select the patterns in the new project panel
    projectSelectedPatternIds = [...patternIds];
    renderProjectExistingGrid();
    updateProjectSelectedCount();
}

function archivePattern(id) {
    const item = patterns.find(p => p.id == id);
    if (!item) return;
    const wasCurrent = currentPatterns.find(p => p.id == id);
    undoableDelete(
        'Pattern archived',
        () => {
            patterns = patterns.filter(p => p.id != id);
            currentPatterns = currentPatterns.filter(p => p.id != id);
            displayPatterns(); displayCurrentPatterns(); loadCategories();
        },
        async () => {
            try {
                const response = await fetch(`${API_URL}/api/patterns/${id}/archive`, { method: 'POST' });
                if (response.ok) loadArchivedPatternsUI();
                else showToast('Error archiving pattern', 'error');
            } catch(e) { console.error('Error archiving pattern:', e); showToast('Error archiving pattern', 'error'); }
        },
        () => {
            patterns.push(item);
            if (wasCurrent) currentPatterns.push(item);
            displayPatterns(); displayCurrentPatterns(); loadCategories();
        }
    );
}

async function restorePattern(id) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/restore`, {
            method: 'POST'
        });

        if (response.ok) {
            showToast('Pattern restored');
            await loadArchivedPatternsUI();
            await loadPatterns();
            await loadCategories();
        } else {
            const error = await response.json();
            showToast('Error restoring pattern: ' + error.error, 'error');
        }
    } catch (error) {
        console.error('Error restoring pattern:', error);
        showToast('Error restoring pattern', 'error');
    }
}

async function permanentlyDeletePattern(id) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/permanent`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showToast('Pattern permanently deleted');
            await loadArchivedPatternsUI();
        } else {
            const error = await response.json();
            showToast('Error deleting pattern: ' + error.error, 'error');
        }
    } catch (error) {
        console.error('Error deleting pattern:', error);
        showToast('Error deleting pattern', 'error');
    }
}

function handleDeleteAllArchived(btn) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm?';
        return;
    }

    // Second click - actually delete
    deleteAllArchivedPatterns(btn);
}

async function deleteAllArchivedPatterns(btn) {
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Deleting...';
    }

    try {
        const response = await fetch(`${API_URL}/api/patterns/archived/all`, {
            method: 'DELETE'
        });

        if (response.ok) {
            const result = await response.json();
            showToast(result.message);
            await loadArchivedPatternsUI();
        } else {
            const error = await response.json();
            showToast('Error: ' + error.error, 'error');
            resetDeleteAllButton();
        }
    } catch (error) {
        console.error('Error deleting all archived:', error);
        showToast('Error deleting archived patterns', 'error');
        resetDeleteAllButton();
    }
}

function resetDeleteAllButton() {
    const btn = document.getElementById('delete-all-archived-btn');
    if (btn) {
        btn.disabled = false;
        btn.classList.remove('confirm-delete');
        btn.textContent = 'Delete All';
    }
}

function handlePermanentDelete(btn, id) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.title = 'Click again to permanently delete';
        return;
    }

    // Second click - actually delete
    permanentlyDeletePattern(id);
}

function formatRelativeDate(dateStr) {
    if (!dateStr) return 'unknown';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return 'today';
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) !== 1 ? 's' : ''} ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) !== 1 ? 's' : ''} ago`;
    return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) !== 1 ? 's' : ''} ago`;
}

async function loadArchivedPatternsUI() {
    const container = document.getElementById('archived-patterns-list');
    if (!container) return;

    try {
        const response = await fetch(`${API_URL}/api/patterns/archived`);
        const archived = await response.json();

        const countEl = document.getElementById('archived-patterns-count');
        if (countEl) {
            countEl.textContent = `${archived.length} archived pattern${archived.length !== 1 ? 's' : ''}`;
        }

        const deleteAllBtn = document.getElementById('delete-all-archived-btn');
        if (deleteAllBtn) {
            deleteAllBtn.style.display = archived.length > 0 ? 'inline-flex' : 'none';
        }

        if (archived.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = archived.map(pattern => `
            <div class="archived-item" data-id="${pattern.id}">
                <div class="archived-info">
                    <span class="archived-name">${escapeHtml(pattern.name)}</span>
                    <span class="archived-meta">${escapeHtml(pattern.category)} · Archived ${formatRelativeDate(pattern.archived_at)}</span>
                </div>
                <div class="archived-actions">
                    <button class="btn btn-small btn-secondary" onclick="restorePattern(${pattern.id})" title="Restore">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="1 4 1 10 7 10"></polyline>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                        </svg>
                    </button>
                    <button class="btn btn-small btn-danger archived-delete-btn" onclick="handlePermanentDelete(this, ${pattern.id})" title="Delete permanently">
                        <svg class="trash-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        <svg class="confirm-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading archived patterns:', error);
        container.innerHTML = '<p class="no-archived">Error loading archived patterns</p>';
    }
}

async function loadArchivedProjectsUI() {
    const container = document.getElementById('archived-projects-list');
    if (!container) return;

    try {
        const response = await fetch(`${API_URL}/api/projects/archived`);
        const archived = await response.json();

        const countEl = document.getElementById('archived-projects-count');
        if (countEl) {
            countEl.textContent = `${archived.length} archived project${archived.length !== 1 ? 's' : ''}`;
        }

        const deleteAllBtn = document.getElementById('delete-all-archived-projects-btn');
        if (deleteAllBtn) {
            deleteAllBtn.style.display = archived.length > 0 ? 'inline-flex' : 'none';
        }

        if (archived.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = archived.map(project => `
            <div class="archived-item" data-id="${project.id}">
                <div class="archived-info">
                    <span class="archived-name">${escapeHtml(project.name)}</span>
                    <span class="archived-meta">Archived ${formatRelativeDate(project.archived_at)}</span>
                </div>
                <div class="archived-actions">
                    <button class="btn btn-small btn-secondary" onclick="restoreProject(${project.id})" title="Restore">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="1 4 1 10 7 10"></polyline>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                        </svg>
                    </button>
                    <button class="btn btn-small btn-danger archived-delete-btn" onclick="handlePermanentDeleteProject(this, ${project.id})" title="Delete permanently">
                        <svg class="trash-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        <svg class="confirm-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading archived projects:', error);
        container.innerHTML = '<p class="no-archived">Error loading archived projects</p>';
    }
}

function handlePermanentDeleteProject(btn, id) {
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.title = 'Click again to permanently delete';
        return;
    }
    permanentlyDeleteProject(id);
}

async function permanentlyDeleteProject(id) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showToast('Project permanently deleted');
            await loadArchivedProjectsUI();
        } else {
            const error = await response.json();
            showToast('Error deleting project: ' + error.error, 'error');
        }
    } catch (error) {
        console.error('Error deleting project:', error);
        showToast('Error deleting project', 'error');
    }
}

function handleDeleteAllArchivedProjects(btn) {
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm?';
        return;
    }
    deleteAllArchivedProjects(btn);
}

async function deleteAllArchivedProjects(btn) {
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Deleting...';
    }

    try {
        const response = await fetch(`${API_URL}/api/projects/archived`);
        const archived = await response.json();

        for (const project of archived) {
            await fetch(`${API_URL}/api/projects/${project.id}`, { method: 'DELETE' });
        }

        showToast('All archived projects deleted');
        await loadArchivedProjectsUI();
    } catch (error) {
        console.error('Error deleting archived projects:', error);
        showToast('Error deleting archived projects', 'error');
    }

    if (btn) {
        btn.disabled = false;
        btn.textContent = 'Delete All';
        btn.classList.remove('confirm-delete');
    }
}

// PDF Viewer functionality
function initPDFViewer() {
    const backBtn = document.getElementById('pdf-back-btn');
    const prevPageBtn = document.getElementById('prev-page-btn');
    const nextPageBtn = document.getElementById('next-page-btn');
    const addCounterBtn = document.getElementById('add-counter-btn');
    const notesBtn = document.getElementById('pdf-notes-btn');
    const notesCloseBtn = document.getElementById('notes-close-btn');
    const editBtn = document.getElementById('pdf-edit-btn');

    backBtn.addEventListener('click', closePDFViewer);
    prevPageBtn.addEventListener('click', () => changePage(-1));
    nextPageBtn.addEventListener('click', () => changePage(1));

    // Desktop floating page arrows
    const desktopPrevPage = document.getElementById('desktop-prev-page');
    const desktopNextPage = document.getElementById('desktop-next-page');
    if (desktopPrevPage) desktopPrevPage.addEventListener('click', () => changePage(-1));
    if (desktopNextPage) desktopNextPage.addEventListener('click', () => changePage(1));
    addCounterBtn.addEventListener('click', () => addCounter());
    notesBtn.addEventListener('click', toggleNotesPopover);
    notesCloseBtn.addEventListener('click', closeNotesPopover);
    editBtn.addEventListener('click', openPdfEditModal);

    // Zoom controls
    document.getElementById('zoom-in-btn').addEventListener('click', zoomIn);
    document.getElementById('zoom-out-btn').addEventListener('click', zoomOut);
    document.getElementById('zoom-fit-btn').addEventListener('click', zoomFitPage);
    document.getElementById('zoom-100-btn').addEventListener('click', zoom100);

    // Editable zoom level input
    const zoomInput = document.getElementById('zoom-level');
    zoomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const inputVal = zoomInput.value.toLowerCase().trim();
            if (inputVal === 'fit') {
                zoomFitPage();
            } else {
                const value = parseInt(inputVal.replace('%', ''));
                if (!isNaN(value) && value >= 10 && value <= 400) {
                    setZoomLevel(value / 100);
                } else {
                    // Reset to current zoom if invalid
                    zoomInput.value = getZoomDisplayString();
                }
            }
            zoomInput.blur();
        } else if (e.key === 'Escape') {
            zoomInput.value = getZoomDisplayString();
            zoomInput.blur();
        }
    });
    zoomInput.addEventListener('focus', () => {
        zoomInput.select();
    });
    zoomInput.addEventListener('blur', () => {
        // Ensure it shows correct value when losing focus
        zoomInput.value = getZoomDisplayString();
    });

    // Pinch to zoom on PDF viewer — CSS transform for smooth live zoom,
    // full hi-res re-render on release
    const pdfWrapper = document.querySelector('.pdf-viewer-wrapper');
    let initialPinchDistance = null;
    let initialZoom = 1.0;
    let pinchRatio = 1.0;

    pdfWrapper.addEventListener('touchstart', (e) => {
        // Skip canvas pinch-zoom when PDF.js iframe viewer is active
        if (pdfWrapper.querySelector('.native-pdf-viewer')) return;
        if (e.touches.length === 2) {
            e.preventDefault();
            initialPinchDistance = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            if (pdfZoomMode === 'fit') {
                initialZoom = pdfFitScale;
            } else if (pdfZoomMode === 'fit-width') {
                initialZoom = pdfFitWidthScale;
            } else {
                initialZoom = pdfZoomScale;
            }
            pinchRatio = 1.0;

            // Set transform origin on canvas to pinch midpoint
            const rect = pdfCanvas.getBoundingClientRect();
            const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
            const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
            pdfCanvas.style.transformOrigin = `${midX}px ${midY}px`;
        }
    }, { passive: false });

    pdfWrapper.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialPinchDistance) {
            e.preventDefault();
            const currentDistance = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            pinchRatio = currentDistance / initialPinchDistance;
            const newZoom = Math.min(Math.max(initialZoom * pinchRatio, 0.25), 4.0);
            pinchRatio = newZoom / initialZoom;

            // Smooth GPU-composited scale on the canvas — no re-render needed
            pdfCanvas.style.transform = `scale(${pinchRatio})`;
            document.getElementById('zoom-level').value = `${Math.round(newZoom * 100)}%`;
        }
    }, { passive: false });

    pdfWrapper.addEventListener('touchend', async (e) => {
        if (initialPinchDistance && e.touches.length < 2) {
            const finalZoom = Math.min(Math.max(initialZoom * pinchRatio, 0.25), 4.0);
            initialPinchDistance = null;

            // Re-render at full hi-res resolution
            pdfZoomScale = finalZoom;
            pdfZoomMode = 'manual';
            pdfCanvas.style.transform = '';
            pdfCanvas.style.transformOrigin = '';
            await renderPage(currentPageNum);

            savePdfViewerState();
        }
    }, { passive: true });

    // Swipe gestures for page navigation and counter control (desktop only — mobile uses bottom bar)
    let swipeStartX = null;
    let swipeStartY = null;
    let swipeStartTime = null;
    const SWIPE_THRESHOLD = 50; // Minimum distance for a swipe
    const SWIPE_TIME_LIMIT = 300; // Maximum time in ms for a swipe
    const isMobileViewport = () => window.matchMedia('(max-width: 768px), (max-height: 500px) and (max-width: 1024px)').matches;

    pdfWrapper.addEventListener('touchstart', (e) => {
        if (isMobileViewport()) return;
        if (e.touches.length === 1) {
            swipeStartX = e.touches[0].pageX;
            swipeStartY = e.touches[0].pageY;
            swipeStartTime = Date.now();
        }
    }, { passive: true });

    // Prevent pull-to-refresh when swiping down at top of page
    pdfWrapper.addEventListener('touchmove', (e) => {
        if (isMobileViewport()) return;
        if (e.touches.length === 1 && pdfWrapper.scrollTop === 0) {
            const deltaY = e.touches[0].pageY - swipeStartY;
            if (deltaY > 0) {
                e.preventDefault();
            }
        }
    }, { passive: false });

    pdfWrapper.addEventListener('touchend', (e) => {
        if (isMobileViewport()) return;
        if (swipeStartX === null || swipeStartY === null) return;
        if (e.touches.length > 0) return; // Still touching with another finger

        const touchEndX = e.changedTouches[0].pageX;
        const touchEndY = e.changedTouches[0].pageY;
        const deltaX = touchEndX - swipeStartX;
        const deltaY = touchEndY - swipeStartY;
        const elapsed = Date.now() - swipeStartTime;

        // Reset swipe tracking
        swipeStartX = null;
        swipeStartY = null;
        swipeStartTime = null;

        // Only register as swipe if it was quick enough
        if (elapsed > SWIPE_TIME_LIMIT) return;

        const absDeltaX = Math.abs(deltaX);
        const absDeltaY = Math.abs(deltaY);

        // Determine if horizontal or vertical swipe
        if (absDeltaX > absDeltaY && absDeltaX > SWIPE_THRESHOLD) {
            // Horizontal swipe - page navigation
            if (deltaX > 0) {
                // Swipe right - previous page
                changePage(-1);
            } else {
                // Swipe left - next page
                changePage(1);
            }
        } else if (absDeltaY > absDeltaX && absDeltaY > SWIPE_THRESHOLD) {
            // Vertical swipe - counter control
            if (deltaY > 0) {
                // Swipe down - decrease counter
                decrementLastUsedCounter();
            } else {
                // Swipe up - increase counter
                incrementLastUsedCounter();
            }
        }
    }, { passive: true });

    // Mouse wheel zoom (with ctrl key for intentional zoom)
    pdfWrapper.addEventListener('wheel', (e) => {
        // Only trigger on ctrl+wheel (intentional zoom), not on trackpad scroll
        if (e.ctrlKey) {
            e.preventDefault();
            // Convert fit mode to actual scale
            if (pdfZoomMode === 'fit') {
                pdfZoomScale = pdfFitScale;
            } else if (pdfZoomMode === 'fit-width') {
                pdfZoomScale = pdfFitWidthScale;
            }
            pdfZoomMode = 'manual';
            // Smaller increments for smoother zoom
            const delta = e.deltaY > 0 ? -0.03 : 0.03;
            pdfZoomScale = Math.min(Math.max(pdfZoomScale + delta, 0.25), 4.0);
            renderPage(currentPageNum);
            savePdfViewerState();
        }
    }, { passive: false });

    // Info button
    const infoBtn = document.getElementById('pdf-info-btn');
    if (infoBtn) {
        infoBtn.addEventListener('click', openPatternInfoModal);
    }

    // PDF Edit modal buttons
    document.getElementById('close-pdf-edit-modal').addEventListener('click', closePdfEditModal);
    document.getElementById('cancel-pdf-edit').addEventListener('click', closePdfEditModal);
    document.getElementById('save-pdf-edit').addEventListener('click', savePdfEdit);
    document.getElementById('delete-pdf-pattern').addEventListener('click', deletePdfPattern);
    document.getElementById('duplicate-pdf-pattern').addEventListener('click', () => { const id = parseInt(currentPattern?.id); if (id) { closePdfEditModal(); duplicatePattern(id); } });
    document.getElementById('copy-to-account-btn').addEventListener('click', () => { const id = parseInt(currentPattern?.id); if (id) { closePdfEditModal(); copyPatternToAccount(id); } });

    // Pattern Info modal buttons
    document.getElementById('close-pattern-info-modal').addEventListener('click', closePatternInfoModal);
    document.getElementById('close-pattern-info-btn').addEventListener('click', closePatternInfoModal);

    // Notes auto-save on input
    const notesEditor = document.getElementById('notes-editor');
    notesEditor.addEventListener('input', scheduleNotesAutoSave);
    // Enable auto-continue for lists and image paste
    setupMarkdownListContinuation(notesEditor);
    setupImagePaste(notesEditor, () => currentPattern?.name || 'pattern');

    // Notes clear button
    const notesClearBtn = document.getElementById('notes-clear-btn');
    notesClearBtn.addEventListener('click', clearNotes);

    // Notes live preview toggle
    const livePreviewCheckbox = document.getElementById('notes-live-preview');
    livePreviewCheckbox.checked = localStorage.getItem('notesLivePreview') === 'true';
    livePreviewCheckbox.addEventListener('change', toggleLivePreview);

    // Notes tab switching
    document.querySelectorAll('.notes-tab').forEach(tab => {
        tab.addEventListener('click', () => switchNotesTab(tab.dataset.tab));
    });

    // Initialize notes popover drag functionality
    initNotesDrag();

    // Keyboard shortcuts for page navigation and counter control
    document.addEventListener('keydown', (e) => {
        // Don't trigger if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        // Handle arrow keys - either scroll PDF or use for shortcuts based on setting
        const arrowKeysScroll = localStorage.getItem('arrowKeysScroll') === 'true';
        const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
        const isPdfOpen = pdfViewerContainer.style.display === 'flex';

        if (isArrowKey && isPdfOpen) {
            if (arrowKeysScroll) {
                // Let arrow keys scroll the PDF
                return;
            } else {
                // Prevent scrolling - arrow keys will be used for shortcuts
                e.preventDefault();
            }
        }

        // Hidden screenshot mode toggle (q key) - cycles: off -> white -> green -> off
        if (e.key === 'q' || e.key === 'Q') {
            const hasWhite = document.body.classList.contains('screenshot-mode-white');
            const hasGreen = document.body.classList.contains('screenshot-mode-green');
            document.body.classList.remove('screenshot-mode-white', 'screenshot-mode-green');
            if (!hasWhite && !hasGreen) {
                document.body.classList.add('screenshot-mode-white');
            } else if (hasWhite) {
                document.body.classList.add('screenshot-mode-green');
            }
            // if hasGreen, we just removed it, so it's off
            return;
        }


        const isPdfViewerOpen = pdfViewerContainer.style.display === 'flex';
        const isMarkdownViewerOpen = markdownViewerContainer && markdownViewerContainer.style.display === 'flex';

        if (!isPdfViewerOpen && !isMarkdownViewerOpen) {
            return;
        }

        // Previous page (PDF only)
        if (matchesShortcut(e.key, 'prevPage') && isPdfViewerOpen) {
            e.preventDefault();
            changePage(-1);
            return;
        }

        // Next page (PDF only)
        if (matchesShortcut(e.key, 'nextPage') && isPdfViewerOpen) {
            e.preventDefault();
            changePage(1);
            return;
        }

        // Increase counter
        if (matchesShortcut(e.key, 'counterIncrease')) {
            e.preventDefault();
            incrementLastUsedCounter();
            return;
        }

        // Decrease counter
        if (matchesShortcut(e.key, 'counterDecrease')) {
            e.preventDefault();
            decrementLastUsedCounter();
            return;
        }

        // Toggle timer
        if (matchesShortcut(e.key, 'toggleTimer')) {
            e.preventDefault();
            toggleTimer();
            return;
        }

        // Next counter
        if (matchesShortcut(e.key, 'nextCounter')) {
            e.preventDefault();
            selectNextCounter();
            return;
        }

        // Zoom in (PDF only)
        if (matchesShortcut(e.key, 'zoomIn') && isPdfViewerOpen) {
            e.preventDefault();
            zoomIn();
            return;
        }

        // Zoom out (PDF only)
        if (matchesShortcut(e.key, 'zoomOut') && isPdfViewerOpen) {
            e.preventDefault();
            zoomOut();
            return;
        }

        // Exit viewer (back button)
        if (matchesShortcut(e.key, 'exitViewer')) {
            e.preventDefault();
            if (isPdfViewerOpen) {
                closePDFViewer();
            } else if (isMarkdownViewerOpen) {
                closeMarkdownViewer();
            }
            return;
        }
    });

    // Media Session API for Bluetooth remotes and media keys
    if ('mediaSession' in navigator) {
        // Helper to dispatch media key to shortcut matching
        const dispatchMediaKey = (key) => {
            // If in shortcut capture mode, capture the key instead
            if (window._yarnlCaptureMediaKey && window._yarnlCaptureMediaKey(key)) {
                return;
            }

            const isPdfViewerOpen = pdfViewerContainer.style.display === 'flex';
            const isMarkdownViewerOpen = markdownViewerContainer && markdownViewerContainer.style.display === 'flex';

            if (!isPdfViewerOpen && !isMarkdownViewerOpen) return;

            // Check each shortcut and execute matching action
            if (matchesShortcut(key, 'prevPage') && isPdfViewerOpen) {
                changePage(-1);
            } else if (matchesShortcut(key, 'nextPage') && isPdfViewerOpen) {
                changePage(1);
            } else if (matchesShortcut(key, 'counterIncrease')) {
                incrementLastUsedCounter();
            } else if (matchesShortcut(key, 'counterDecrease')) {
                decrementLastUsedCounter();
            } else if (matchesShortcut(key, 'toggleTimer')) {
                toggleTimer();
            } else if (matchesShortcut(key, 'nextCounter')) {
                selectNextCounter();
            } else if (matchesShortcut(key, 'zoomIn') && isPdfViewerOpen) {
                zoomIn();
            } else if (matchesShortcut(key, 'zoomOut') && isPdfViewerOpen) {
                zoomOut();
            } else if (matchesShortcut(key, 'exitViewer')) {
                if (isPdfViewerOpen) {
                    closePDFViewer();
                } else if (isMarkdownViewerOpen) {
                    closeMarkdownViewer();
                }
            }
        };

        // Set up media session handlers (always registered, but only work when audio is playing)
        navigator.mediaSession.setActionHandler('play', () => dispatchMediaKey('MediaPlayPause'));
        navigator.mediaSession.setActionHandler('pause', () => dispatchMediaKey('MediaPlayPause'));
        navigator.mediaSession.setActionHandler('nexttrack', () => dispatchMediaKey('MediaTrackNext'));
        navigator.mediaSession.setActionHandler('previoustrack', () => dispatchMediaKey('MediaTrackPrevious'));
        navigator.mediaSession.setActionHandler('stop', () => dispatchMediaKey('MediaStop'));

        // Toggle function for enabling/disabling media remote
        let silentAudio = null;
        window.toggleMediaRemote = (enabled) => {
            if (enabled) {
                if (!silentAudio) {
                    silentAudio = document.createElement('audio');
                    silentAudio.src = '/silence.wav';
                    silentAudio.loop = true;
                    silentAudio.volume = 0.01;
                    document.body.appendChild(silentAudio);
                }
                silentAudio.play().then(() => {
                    console.log('Media remote audio playing');
                    navigator.mediaSession.metadata = new MediaMetadata({
                        title: 'Yarnl Remote Active',
                        artist: 'Pattern Viewer'
                    });
                    navigator.mediaSession.playbackState = 'playing';
                }).catch((e) => {
                    console.error('Media remote failed to start:', e);
                });
            } else {
                if (silentAudio) {
                    silentAudio.pause();
                }
                navigator.mediaSession.playbackState = 'paused';
            }
            localStorage.setItem('mediaRemoteEnabled', enabled);
        };

        // Initialize from saved preference
        const remoteCheckbox = document.getElementById('media-remote-enabled');
        if (remoteCheckbox) {
            const savedPref = localStorage.getItem('mediaRemoteEnabled') === 'true';
            remoteCheckbox.checked = savedPref;
            // Don't auto-start on page load - needs user gesture
            // Instead, start on first user interaction if preference was enabled
            if (savedPref) {
                const startOnInteraction = () => {
                    if (remoteCheckbox.checked && (!silentAudio || silentAudio.paused)) {
                        window.toggleMediaRemote(true);
                    }
                    document.removeEventListener('click', startOnInteraction);
                    document.removeEventListener('keydown', startOnInteraction);
                };
                document.addEventListener('click', startOnInteraction);
                document.addEventListener('keydown', startOnInteraction);
            }
            remoteCheckbox.addEventListener('change', (e) => {
                window.toggleMediaRemote(e.target.checked);
                showToast(e.target.checked ? 'Media remote enabled' : 'Media remote disabled');
            });
        }

        // Arrow keys scroll PDF setting
        const arrowKeysScrollCheckbox = document.getElementById('arrow-keys-scroll');
        if (arrowKeysScrollCheckbox) {
            arrowKeysScrollCheckbox.checked = localStorage.getItem('arrowKeysScroll') === 'true';
            arrowKeysScrollCheckbox.addEventListener('change', (e) => {
                localStorage.setItem('arrowKeysScroll', e.target.checked);
                showToast(e.target.checked ? 'Arrow keys will scroll PDF' : 'Arrow keys control counters/navigation');
            });
        }
    }
}

// Handle pattern card click - supports cmd/ctrl+click to open in new window
function handlePatternClick(event, patternId) {
    // If in bulk selection mode, taps toggle selection
    if (selectedPatternIds.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        const card = event.currentTarget || event.target.closest('.pattern-card');
        if (card) toggleBulkSelect(patternId, card.querySelector('.bulk-select-checkbox') || card);
        return;
    }
    // Check for cmd (Mac) or ctrl (Windows/Linux) key
    if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        // Find pattern to get slug
        const pattern = patterns.find(p => p.id === patternId) || currentPatterns.find(p => p.id === patternId);
        const slug = pattern ? getPatternSlug(pattern) : patternId;
        // Open in new window/tab with full URL
        const url = window.location.origin + window.location.pathname + '#pattern/' + slug;
        window.open(url, '_blank');
    } else {
        openPDFViewer(patternId);
    }
}

// ── Mobile Long Press for Bulk Select ──
let longPressTimer = null;
let longPressTriggered = false;

function initLongPress(card) {
    card.addEventListener('touchstart', (e) => {
        longPressTriggered = false;
        const patternId = parseInt(card.dataset.patternId);
        longPressTimer = setTimeout(() => {
            longPressTriggered = true;
            // Vibrate if available
            if (navigator.vibrate) navigator.vibrate(30);
            const checkbox = card.querySelector('.bulk-select-checkbox') || card;
            toggleBulkSelect(patternId, checkbox);
        }, 500);
    }, { passive: true });

    card.addEventListener('touchend', (e) => {
        clearTimeout(longPressTimer);
        if (longPressTriggered) {
            e.preventDefault();
        }
    });

    card.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
    }, { passive: true });

    card.addEventListener('contextmenu', (e) => {
        if (longPressTimer || longPressTriggered) {
            e.preventDefault();
        }
    });
}

// ── Bulk Selection ──

function toggleBulkSelect(patternId, el) {
    if (selectedPatternIds.has(patternId)) {
        selectedPatternIds.delete(patternId);
    } else {
        selectedPatternIds.add(patternId);
    }
    // Update the card's visual state
    const card = el.closest('.pattern-card');
    if (card) card.classList.toggle('bulk-selected', selectedPatternIds.has(patternId));
    updateBulkToolbar();
}

function clearBulkSelection() {
    selectedPatternIds.clear();
    document.querySelectorAll('.bulk-selected').forEach(c => c.classList.remove('bulk-selected'));
    updateBulkToolbar();
}

function updateBulkToolbar() {
    const toolbar = document.getElementById('bulk-toolbar');
    if (!toolbar) return;
    if (selectedPatternIds.size === 0) {
        toolbar.style.display = 'none';
        return;
    }
    const ids = Array.from(selectedPatternIds);
    const selected = patterns.filter(p => ids.includes(p.id))
        .concat(currentPatterns.filter(p => ids.includes(p.id)));
    const seen = new Set();
    const unique = selected.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    const allFav = unique.every(p => p.is_favorite);
    const allCurrent = unique.every(p => p.is_current);
    const allComplete = unique.every(p => p.completed);
    const bulkStars = [1,2,3,4,5].map(i =>
        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" style="cursor:pointer" onclick="bulkQuickRating(${i})">${STAR_SVG}</svg>`
    ).join('');
    toolbar.innerHTML = `<span id="bulk-count">${selectedPatternIds.size} selected</span>
        <button class="btn btn-sm bulk-quick-btn ${allCurrent ? 'active' : ''}" onclick="bulkQuickToggle('current', ${!allCurrent})" title="${allCurrent ? 'Remove In Progress' : 'Mark In Progress'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${allCurrent ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
        <button class="btn btn-sm bulk-fav-btn ${allFav ? 'active' : ''}" onclick="bulkQuickToggle('favorite', ${!allFav})" title="${allFav ? 'Unfavorite' : 'Favorite'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${allFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
        </button>
        <button class="btn btn-sm bulk-quick-btn ${allComplete ? 'active' : ''}" onclick="bulkQuickToggle('complete', ${!allComplete})" title="${allComplete ? 'Mark Incomplete' : 'Mark Complete'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </button>
        <span class="bulk-rating-stars" title="Set rating">${bulkStars}</span>
        <button class="btn btn-sm bulk-quick-btn" onclick="addPatternsToNewProject(Array.from(selectedPatternIds))" title="Add to Project">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </button>
        ${enableDirectDelete
            ? `<button class="btn btn-sm btn-danger bulk-quick-btn" onclick="bulkDelete(this)" title="Delete All"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`
            : `<button class="btn btn-sm btn-secondary bulk-quick-btn" onclick="bulkArchive(this)" title="Archive All"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg></button>`
        }
        <button class="btn btn-primary btn-sm" onclick="openBulkEditModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            <span class="bulk-edit-label">Edit</span>
        </button>
        <button class="btn btn-sm btn-secondary" onclick="clearBulkSelection()">Clear</button>`;
    toolbar.style.display = 'flex';
}

async function bulkQuickToggle(field, value) {
    const patternIds = Array.from(selectedPatternIds);
    const endpoint = field === 'current' ? 'current' : field === 'complete' ? 'complete' : 'favorite';
    const bodyKey = field === 'current' ? 'isCurrent' : field === 'complete' ? 'completed' : 'isFavorite';
    await fetch(`${API_URL}/api/patterns/bulk/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternIds, [bodyKey]: value })
    });
    await Promise.all([loadPatterns(), loadCurrentPatterns()]);
    updateBulkToolbar();
    showToast(`Updated ${patternIds.length} pattern${patternIds.length > 1 ? 's' : ''}`);
}

async function bulkQuickRating(rating) {
    const patternIds = Array.from(selectedPatternIds);
    await fetch(`${API_URL}/api/patterns/bulk/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternIds, rating })
    });
    await Promise.all([loadPatterns(), loadCurrentPatterns()]);
    updateBulkToolbar();
    showToast(`Rated ${patternIds.length} pattern${patternIds.length > 1 ? 's' : ''} ${rating} star${rating > 1 ? 's' : ''}`);
}

// Escape key clears bulk selection
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedPatternIds.size > 0) {
        clearBulkSelection();
    }
    if (e.key === 'Escape' && (selectedYarnIds.size > 0 || selectedHookIds.size > 0)) {
        clearInventorySelection();
    }
});

// ── Bulk Edit Modal ──

function openBulkEditModal() {
    const count = selectedPatternIds.size;
    if (count === 0) return;

    document.getElementById('bulk-edit-count').textContent = `(${count} pattern${count > 1 ? 's' : ''})`;

    // Populate hashtag selector (none pre-selected)
    document.getElementById('bulk-add-hashtags').innerHTML = createHashtagSelector('bulk-add', []);

    // Populate category dropdown with "No change" default
    const categoryHtml = createCategoryDropdown('bulk-category', '');
    document.getElementById('bulk-category-container').innerHTML = categoryHtml;
    // Override displayed value to show placeholder
    const dropdown = document.querySelector('.category-dropdown[data-id="bulk-category"]');
    if (dropdown) {
        dropdown.dataset.value = '';
        dropdown.querySelector('.category-dropdown-value').textContent = 'No change';
    }

    // Show archive or delete based on user setting
    const dangerEl = document.getElementById('bulk-danger-actions');
    if (enableDirectDelete) {
        dangerEl.innerHTML = `<button class="btn btn-danger btn-sm" onclick="bulkDelete(this)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete All</button>`;
    } else {
        dangerEl.innerHTML = `<button class="btn btn-secondary btn-sm" onclick="bulkArchive(this)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
            Archive All</button>`;
    }

    // Reset status buttons and disable remove buttons when no selected patterns have that status
    const selectedList = Array.from(selectedPatternIds);
    const selectedPatterns = patterns.filter(p => selectedList.includes(p.id))
        .concat(currentPatterns.filter(p => selectedList.includes(p.id)));
    // Dedupe by id
    const seen = new Set();
    const uniqueSelected = selectedPatterns.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });

    const anyCurrent = uniqueSelected.some(p => p.is_current);
    const anyComplete = uniqueSelected.some(p => p.completed);
    const anyFavorite = uniqueSelected.some(p => p.is_favorite);

    // Reset all buttons
    document.querySelectorAll('.bulk-status-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.disabled = false;
        btn.dataset.touched = '';
    });

    // Remove row: pre-activate if any selected have that status, disable if none do
    const statusMap = { current: anyCurrent, complete: anyComplete, favorite: anyFavorite };
    const labelMap = { current: 'in progress', complete: 'complete', favorite: 'favorited' };
    document.querySelectorAll('.bulk-status-btn[data-action="remove"]').forEach(btn => {
        const has = statusMap[btn.dataset.field];
        btn.disabled = !has;
        btn.classList.toggle('active', has);
        btn.title = has ? 'Click to remove' : `No selected patterns are ${labelMap[btn.dataset.field]}`;
    });

    // Rating input (default 0 = no change)
    document.getElementById('bulk-rating').innerHTML = ratingInputHtml('bulk-rating-input', 0);

    document.getElementById('bulk-edit-modal').style.display = 'flex';
}

function closeBulkEditModal() {
    document.getElementById('bulk-edit-modal').style.display = 'none';
}

// Changelog modal
let currentAppVersion = null;

async function checkForNewVersion() {
    try {
        const res = await fetch(`${API_URL}/api/version`);
        if (!res.ok) return;
        const data = await res.json();
        const version = data.version;
        const lastSeen = localStorage.getItem('lastSeenVersion');
        if (!lastSeen || lastSeen !== version) {
            if (localStorage.getItem('showWhatsNew') === 'false') {
                _originalSetItem('lastSeenVersion', version);
            } else {
                showChangelog(version);
            }
        }
    } catch (e) {
        // Silently fail
    }
}

async function showChangelog(version) {
    currentAppVersion = version;
    const body = document.getElementById('changelog-body');
    const header = document.querySelector('#changelog-modal .modal-header h2');
    if (header) header.textContent = `What's New in v${version}`;

    // Fetch release notes from GitHub
    let md = `Updated to v${version}.`;
    try {
        const res = await fetch('https://api.github.com/repos/titandrive/yarnl/releases/latest');
        if (res.ok) {
            const data = await res.json();
            if (data.body) {
                // Strip the version heading if present (e.g. "## v0.5.7\n\n")
                md = data.body.replace(/^##?\s*v[\d.]+\s*\n+/, '');
            }
        }
    } catch (e) {
        // Fallback to simple message
    }

    if (body && typeof marked !== 'undefined') {
        body.innerHTML = marked.parse(md);
    }
    document.getElementById('changelog-modal').style.display = 'flex';
    document.addEventListener('keydown', handleChangelogEscape);
}

function closeChangelog() {
    document.getElementById('changelog-modal').style.display = 'none';
    document.removeEventListener('keydown', handleChangelogEscape);
    if (currentAppVersion) {
        _originalSetItem('lastSeenVersion', currentAppVersion);
    }
}

function disableChangelog() {
    localStorage.setItem('showWhatsNew', 'false');
    const whatsNewCheckbox = document.getElementById('whats-new-checkbox');
    if (whatsNewCheckbox) whatsNewCheckbox.checked = false;
    closeChangelog();
    showToast('What\'s New popup disabled — re-enable in Settings');
}

function handleChangelogEscape(e) {
    if (e.key === 'Escape') closeChangelog();
}

// Wire up changelog modal buttons
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('changelog-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeChangelog();
        });
    }
    document.getElementById('close-changelog-modal')?.addEventListener('click', closeChangelog);
    document.getElementById('dismiss-changelog')?.addEventListener('click', closeChangelog);
});

async function applyBulkEdit() {
    const patternIds = Array.from(selectedPatternIds);
    const addHashtagIds = getSelectedHashtagIds('bulk-add');
    const category = getCategoryDropdownValue('bulk-category');

    // Read status button states
    // Set row: active = user wants to set this status
    // Remove row: starts active if any selected have it; user clicks OFF to remove
    //   - still active (untouched) = no change
    //   - inactive + was touched = remove
    function getStatusAction(field) {
        const setBtn = document.querySelector(`.bulk-status-btn[data-field="${field}"][data-action="set"]`);
        const removeBtn = document.querySelector(`.bulk-status-btn[data-field="${field}"][data-action="remove"]`);
        if (setBtn?.classList.contains('active')) return 'set';
        if (removeBtn && removeBtn.dataset.touched === 'true' && !removeBtn.classList.contains('active')) return 'remove';
        return 'none';
    }

    const currentAction = getStatusAction('current');
    const completeAction = getStatusAction('complete');
    const favoriteAction = getStatusAction('favorite');

    const promises = [];

    // Apply hashtag changes
    if (addHashtagIds.length > 0) {
        promises.push(fetch(`${API_URL}/api/patterns/bulk/hashtags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds, addHashtagIds, removeHashtagIds: [] })
        }));
    }

    // Apply category change
    if (category) {
        promises.push(fetch(`${API_URL}/api/patterns/bulk/category`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds, category })
        }));
    }

    // Apply status changes
    if (currentAction !== 'none') {
        promises.push(fetch(`${API_URL}/api/patterns/bulk/current`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds, isCurrent: currentAction === 'set' })
        }));
    }
    if (completeAction !== 'none') {
        promises.push(fetch(`${API_URL}/api/patterns/bulk/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds, completed: completeAction === 'set' })
        }));
    }
    if (favoriteAction !== 'none') {
        promises.push(fetch(`${API_URL}/api/patterns/bulk/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds, isFavorite: favoriteAction === 'set' })
        }));
    }

    // Apply rating change
    const bulkRating = parseInt(document.getElementById('bulk-rating-input')?.dataset.rating) || 0;
    if (bulkRating > 0) {
        promises.push(fetch(`${API_URL}/api/patterns/bulk/rating`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds, rating: bulkRating })
        }));
    }

    if (promises.length > 0) {
        await Promise.all(promises);
        closeBulkEditModal();
        clearBulkSelection();
        await Promise.all([loadPatterns(), loadCurrentPatterns()]);
        showToast(`Updated ${patternIds.length} pattern${patternIds.length > 1 ? 's' : ''}`);
    } else {
        showToast('No changes selected');
    }
}

async function bulkArchive(btn) {
    if (!btn.classList.contains('confirm-danger')) {
        btn.classList.add('confirm-danger');
        btn.textContent = 'Confirm Archive?';
        setTimeout(() => {
            if (btn.classList.contains('confirm-danger')) {
                btn.classList.remove('confirm-danger');
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg> Archive All`;
            }
        }, 3000);
        return;
    }

    const count = selectedPatternIds.size;
    const patternIds = Array.from(selectedPatternIds);
    await fetch(`${API_URL}/api/patterns/bulk/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternIds })
    });

    closeBulkEditModal();
    clearBulkSelection();
    await Promise.all([loadPatterns(), loadCurrentPatterns()]);
    showToast(`Archived ${count} pattern${count > 1 ? 's' : ''}`);
}

async function bulkDelete(btn) {
    if (!btn.classList.contains('confirm-danger')) {
        btn.classList.add('confirm-danger');
        btn.textContent = 'Confirm Delete?';
        setTimeout(() => {
            if (btn.classList.contains('confirm-danger')) {
                btn.classList.remove('confirm-danger');
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Delete All`;
            }
        }, 3000);
        return;
    }

    const count = selectedPatternIds.size;
    const patternIds = Array.from(selectedPatternIds);
    await fetch(`${API_URL}/api/patterns/bulk/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patternIds })
    });

    closeBulkEditModal();
    clearBulkSelection();
    await Promise.all([loadPatterns(), loadCurrentPatterns()]);
    showToast(`Deleted ${count} pattern${count > 1 ? 's' : ''}`);
}

function toggleBulkStatusBtn(btn) {
    const field = btn.dataset.field;
    const action = btn.dataset.action;
    const opposite = action === 'set' ? 'remove' : 'set';
    const oppositeBtn = document.querySelector(`.bulk-status-btn[data-field="${field}"][data-action="${opposite}"]`);

    btn.dataset.touched = 'true';
    btn.classList.toggle('active');

    // If activating set, deactivate remove (and vice versa)
    if (btn.classList.contains('active') && oppositeBtn) {
        oppositeBtn.classList.remove('active');
        oppositeBtn.dataset.touched = 'true';
    }
}

async function openPDFViewer(patternId, pushHistory = true) {
    try {
        // Convert to number for comparison
        const id = parseInt(patternId);

        // Always fetch fresh data from API to ensure we have the latest current_page
        const response = await fetch(`${API_URL}/api/patterns/${id}`);
        if (!response.ok) {
            console.error('Pattern not found');
            return;
        }
        const pattern = await response.json();

        // Track last opened time (fire-and-forget)
        fetch(`${API_URL}/api/patterns/${id}/opened`, { method: 'POST' }).catch(() => {});

        // Get slug for URL
        const slug = getPatternSlug(pattern);

        // Push to navigation history
        if (pushHistory && !isNavigatingBack) {
            const currentView = getCurrentView();
            if (currentView && !currentView.startsWith('pattern/')) {
                navigationHistory.push(currentView);
            }
            history.pushState({ view: `pattern/${slug}` }, '', `#pattern/${slug}`);
        }

        // Route to appropriate viewer based on pattern type
        if (pattern.pattern_type === 'markdown') {
            await openMarkdownViewer(pattern, false); // Don't push history again, already done above
            return;
        }

        currentPattern = pattern;
        currentPageNum = pattern.current_page || 1;

        // Load saved viewer state for this pattern, or use default zoom
        const savedState = loadPdfViewerState(pattern.id);
        if (savedState) {
            pdfZoomMode = savedState.zoomMode;
            pdfZoomScale = savedState.zoomScale;
        } else {
            // Apply default zoom setting for new patterns
            const defaultZoom = localStorage.getItem('defaultPdfZoom') || 'fit';
            if (defaultZoom === 'fit') {
                pdfZoomMode = 'fit';
            } else if (defaultZoom === 'fit-width') {
                pdfZoomMode = 'fit-width';
            } else {
                pdfZoomMode = 'manual';
                pdfZoomScale = parseInt(defaultZoom) / 100;
            }
        }

        // Load timer state
        loadPatternTimer(pattern);

        // Initialize auto timer: restore per-pattern session state, else use default
        const savedAutoTimer = sessionStorage.getItem(`autoTimer_${pattern.id}`);
        autoTimerEnabled = savedAutoTimer !== null ? savedAutoTimer === 'true' : autoTimerDefault;
        autoTimerPausedInactive = false;
        updateAutoTimerButtonState();
        if (autoTimerEnabled) {
            // Start timer and inactivity tracking
            startTimer();
            if (inactivityTimeout) clearTimeout(inactivityTimeout);
            if (inactivityDelay > 0) {
                inactivityTimeout = setTimeout(() => {
                    if (autoTimerEnabled && timerRunning) {
                        autoTimerPausedInactive = true;
                        stopTimer();
                        updateAutoTimerButtonState();
                    }
                }, inactivityDelay);
            }
        }

        // Clear old counters and move overlay before showing viewer
        document.getElementById('counters-list').innerHTML = '';
        const counterOverlay = document.getElementById('shared-counter-overlay');
        pdfViewerContainer.appendChild(counterOverlay);

        // Hide tabs and show PDF viewer
        document.querySelector('.tabs').style.display = 'none';
        tabContents.forEach(c => c.style.display = 'none');
        pdfViewerContainer.style.display = 'flex';
        requestWakeLock();

        // Re-show mobile bottom bar (cleared by tab switch)
        const mobileBottomBar = document.getElementById('mobile-bottom-bar');
        if (mobileBottomBar) mobileBottomBar.style.display = '';

        // Update header
        document.getElementById('pdf-pattern-name').textContent = pattern.name;
        const mobilePatternName = document.getElementById('mobile-pattern-name');
        if (mobilePatternName) mobilePatternName.textContent = pattern.name;

        // Wait for any in-flight annotation save to finish before loading
        if (pendingAnnotationSaves[pattern.id]) {
            await pendingAnnotationSaves[pattern.id].catch(() => {});
        }

        const cacheV = pdfCacheVersions[pattern.id];
        // Use absolute URL so pdf.js viewer's new URL() parsing preserves ?v= query params
        const pdfUrl = `${window.location.origin}${API_URL}/api/patterns/${pattern.id}/file${cacheV ? '?v=' + cacheV : ''}`;
        const isMobile = window.matchMedia('(max-width: 768px), (max-height: 500px) and (max-width: 1024px)').matches;

        // Use PDF.js full viewer in iframe for all devices
        const wrapper = document.querySelector('.pdf-viewer-wrapper');
        wrapper.querySelector('.pdf-page-container').style.display = 'none';
        const spacer = wrapper.querySelector('.pdf-scroll-spacer');
        if (spacer) spacer.style.display = 'none';
        const zoomOverlay = wrapper.querySelector('.pdf-zoom-overlay');
        if (zoomOverlay) zoomOverlay.style.display = 'none';
        const navControls = document.querySelector('.pdf-nav-controls');
        if (navControls) navControls.style.display = 'none';

        let pdfIframe = wrapper.querySelector('.native-pdf-viewer');
        if (!pdfIframe) {
            pdfIframe = document.createElement('iframe');
            pdfIframe.className = 'native-pdf-viewer';
            wrapper.prepend(pdfIframe);
        }

        // Reuse cached iframe if same pattern is already loaded
        const canReuse = pdfIframe.dataset.patternId === String(pattern.id) && pdfIframe.contentWindow;
        pdfIframe.style.display = '';
        if (!canReuse) {
            pdfIframe.dataset.patternId = String(pattern.id);
            const encodedUrl = encodeURIComponent(pdfUrl);
            pdfIframe.src = `/pdfjs/web/viewer.html?file=${encodedUrl}#page=${currentPageNum}&pagemode=none`;
        }

        // Configure viewer and track page changes via PDF.js API
        if (!canReuse) pdfIframe.addEventListener('load', () => {
            const viewerApp = pdfIframe.contentWindow?.PDFViewerApplication;
            if (!viewerApp) return;
            let userHasEdited = false;
            viewerApp.initializedPromise.then(() => {
                // Set scroll mode from user preference (page=3, scroll=0)
                const scrollPref = localStorage.getItem('pdfScrollMode') || 'scroll';
                viewerApp.pdfViewer.scrollMode = scrollPref === 'page' ? 3 : 0;
                // Hide mobile page buttons in scroll mode unless setting is on
                if (scrollPref === 'scroll' && localStorage.getItem('scrollPageButtons') !== 'true') {
                    const bar = document.getElementById('mobile-bottom-bar');
                    if (bar) {
                        const prev = bar.querySelector('.mobile-page-prev');
                        const next = bar.querySelector('.mobile-page-next');
                        if (prev) prev.style.display = 'none';
                        if (next) next.style.display = 'none';
                    }
                }
                // Show/hide desktop page arrows based on scroll mode + setting
                const hideDesktopArrows = scrollPref === 'scroll' && localStorage.getItem('scrollPageButtons') !== 'true';
                const dPrev = document.getElementById('desktop-prev-page');
                const dNext = document.getElementById('desktop-next-page');
                if (dPrev) dPrev.style.display = hideDesktopArrows ? 'none' : '';
                if (dNext) dNext.style.display = hideDesktopArrows ? 'none' : '';
                // Forward keydown events from iframe to parent so shortcuts work
                pdfIframe.contentDocument.addEventListener('keydown', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                    const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
                    const arrowKeysScroll = localStorage.getItem('arrowKeysScroll') === 'true';
                    if (isArrowKey && arrowKeysScroll) return;
                    e.preventDefault();
                    e.stopPropagation();
                    document.dispatchEvent(new KeyboardEvent('keydown', {
                        key: e.key, code: e.code, keyCode: e.keyCode,
                        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
                        bubbles: true
                    }));
                });

                viewerApp.eventBus.on('pagechanging', (evt) => {
                    currentPageNum = evt.pageNumber;
                    mobileBar.updatePageInfo();
                    // Update desktop arrow disabled states
                    if (dPrev) dPrev.disabled = evt.pageNumber <= 1;
                    if (dNext) dNext.disabled = evt.pageNumber >= viewerApp.pagesCount;
                });
                // Auto-save annotations - set up after document loads
                const patternId = pattern.id;
                let annotationSaveTimer = null;
                let annotationSaving = false;

                async function saveAnnotations() {
                    if (annotationSaving) return;
                    annotationSaving = true;
                    try {
                        await commitAndSave();
                        showToast('Annotations saved', 'success', 1500);
                    } catch (err) {
                        console.error('Error saving annotations:', err);
                        showToast('Failed to save annotations', 'error');
                    } finally {
                        annotationSaving = false;
                    }
                }

                // Override save/download immediately
                viewerApp.save = async function() {
                    clearTimeout(annotationSaveTimer);
                    await saveAnnotations();
                };
                viewerApp.download = viewerApp.save.bind(viewerApp);
                viewerApp.downloadOrSave = viewerApp.save.bind(viewerApp);

                // Commit active drawing session and save PDF with annotations
                async function commitAndSave() {
                    const currentMode = viewerApp.pdfViewer.annotationEditorMode;
                    if (currentMode !== 0) {
                        viewerApp.pdfViewer.annotationEditorMode = { mode: 0 };
                        await new Promise(r => setTimeout(r, 100));
                    }
                    const data = await viewerApp.pdfDocument.saveDocument();
                    if (currentMode !== 0) {
                        viewerApp.pdfViewer.annotationEditorMode = { mode: currentMode };
                    }
                    const resp = await fetch(`${API_URL}/api/patterns/${patternId}/file`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/pdf' },
                        body: data
                    });
                    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
                    pdfCacheVersions[patternId] = Date.now();
                }

                // Wire up the Revert button (inside Edit modal) — click-to-confirm pattern
                const revertBtn = document.getElementById('pdf-revert-btn');
                let revertConfirmTimer = null;
                revertBtn.onclick = async () => {
                    // First click: ask for confirmation
                    if (!revertBtn.classList.contains('confirming')) {
                        revertBtn.classList.add('confirming');
                        revertBtn.textContent = 'Confirm Revert?';
                        revertConfirmTimer = setTimeout(() => {
                            revertBtn.classList.remove('confirming');
                            revertBtn.textContent = 'Revert Annotations';
                        }, 3000);
                        return;
                    }
                    // Second click: do the revert
                    clearTimeout(revertConfirmTimer);
                    revertBtn.classList.remove('confirming');
                    revertBtn.disabled = true;
                    try {
                        revertBtn.textContent = 'Reverting…';
                        clearTimeout(annotationSaveTimer);
                        annotationSaving = true;
                        const resp = await fetch(`${API_URL}/api/patterns/${patternId}/annotations`, { method: 'DELETE' });
                        const result = await resp.json();
                        if (result.reverted) {
                            pdfCacheVersions[patternId] = Date.now();
                            document.getElementById('pdf-edit-modal').style.display = 'none';
                            const iframe = wrapper.querySelector('.native-pdf-viewer');
                            if (iframe) iframe.remove();
                            revertBtn.textContent = 'Revert Annotations';
                            openPDFViewer(patternId, false);
                        } else {
                            annotationSaving = false;
                            revertBtn.textContent = 'No annotations to revert';
                            setTimeout(() => { revertBtn.textContent = 'Revert Annotations'; }, 1500);
                        }
                    } catch (e) {
                        annotationSaving = false;
                        revertBtn.textContent = 'Error';
                        console.error('Revert failed:', e);
                        setTimeout(() => { revertBtn.textContent = 'Revert Annotations'; }, 2000);
                    } finally {
                        revertBtn.disabled = false;
                    }
                };

                viewerApp.eventBus.on('pagesloaded', () => {
                    totalPages = viewerApp.pagesCount;
                    mobileBar.updatePageInfo();

                    // Restore saved zoom level and scroll position
                    const saved = loadPdfViewerState(patternId);
                    if (saved?.nativeZoom) {
                        viewerApp.pdfViewer.currentScaleValue = saved.nativeZoom;
                        // Restore scroll after zoom renders
                        if (saved.scrollX || saved.scrollY) {
                            setTimeout(() => {
                                const container = viewerApp.pdfViewer.container;
                                if (container) {
                                    container.scrollLeft = saved.scrollX;
                                    container.scrollTop = saved.scrollY;
                                }
                            }, 200);
                        }
                    }

                    // Double-tap-and-drag zoom on mobile
                    if (window.matchMedia('(max-width: 768px)').matches) {
                        const viewer = viewerApp.pdfViewer;
                        const container = viewer.container;
                        let lastTapTime = 0;
                        let lastTapY = 0;
                        let dragZooming = false;
                        let dragStartY = 0;
                        let dragStartScale = 1;
                        let tapX = 0;
                        let tapY = 0;
                        let scrollXAtStart = 0;
                        let scrollYAtStart = 0;

                        container.addEventListener('touchstart', (e) => {
                            if (e.touches.length !== 1) return;
                            const now = Date.now();
                            const y = e.touches[0].clientY;

                            if (now - lastTapTime < 300 && Math.abs(y - lastTapY) < 50) {
                                e.preventDefault();
                                dragZooming = true;
                                dragStartY = y;
                                dragStartScale = viewer.currentScale;
                                const rect = container.getBoundingClientRect();
                                tapX = e.touches[0].clientX - rect.left + container.scrollLeft;
                                tapY = e.touches[0].clientY - rect.top + container.scrollTop;
                                scrollXAtStart = container.scrollLeft;
                                scrollYAtStart = container.scrollTop;
                            }
                            lastTapTime = now;
                            lastTapY = y;
                        }, { passive: false });

                        container.addEventListener('touchmove', (e) => {
                            if (!dragZooming || e.touches.length !== 1) return;
                            e.preventDefault();
                            const deltaY = e.touches[0].clientY - dragStartY;
                            const zoomFactor = Math.pow(1.01, deltaY);
                            const newScale = Math.min(5, Math.max(0.25, dragStartScale * zoomFactor));
                            const ratio = newScale / dragStartScale;
                            viewer.currentScale = newScale;
                            container.scrollLeft = tapX * ratio - (tapX - scrollXAtStart);
                            container.scrollTop = tapY * ratio - (tapY - scrollYAtStart);
                        }, { passive: false });

                        container.addEventListener('touchend', () => {
                            dragZooming = false;
                        });
                    }

                    // Defer hook so it runs AFTER viewer's own _initializeAnnotationStorageCallbacks
                    setTimeout(() => {
                        const storage = viewerApp.pdfDocument?.annotationStorage;
                        if (storage) {
                            const origOnSetModified = storage.onSetModified;
                            storage.onSetModified = () => {
                                if (origOnSetModified) origOnSetModified();
                                if (!userHasEdited) return; // Skip initial load of embedded annotations
                                clearTimeout(annotationSaveTimer);
                                annotationSaveTimer = setTimeout(saveAnnotations, 2000);
                            };
                        }
                    }, 500);
                });

                // Also catch annotation changes via eventBus as a backup
                viewerApp.eventBus.on('annotationeditorstateschanged', (evt) => {
                    if (evt.details?.hasSomethingToUndo) {
                        userHasEdited = true;
                        clearTimeout(annotationSaveTimer);
                        annotationSaveTimer = setTimeout(saveAnnotations, 2000);
                    }
                });

                // Hide the download button - saving is automatic
                const iframeDoc = pdfIframe.contentDocument;
                if (iframeDoc) {
                    const style = iframeDoc.createElement('style');
                    let cssText = '#download, #secondaryDownload, #openFile, #secondaryOpenFile { display: none !important; }';
                    // On mobile, hide the PDF.js toolbar to maximize viewing space
                    if (isMobile) {
                        cssText += ' #toolbarContainer { display: none !important; } #viewerContainer { top: 0 !important; }';
                    }
                    style.textContent = cssText;
                    iframeDoc.head.appendChild(style);
                }
            });
        }, { once: true });

        await loadCounters(pattern.id);

    } catch (error) {
        console.error('Error opening PDF viewer:', error);
    }
}

async function renderPage(pageNum) {
    try {
        const page = await pdfDoc.getPage(pageNum);

        const canvas = pdfCanvas;
        const context = canvas.getContext('2d');

        const wrapper = document.querySelector('.pdf-viewer-wrapper');
        const counterOverlay = document.getElementById('shared-counter-overlay');
        // Counter overlay is position:fixed, so we need to subtract its height from available space
        const counterOverlayHeight = counterOverlay ? counterOverlay.offsetHeight : 0;
        const containerWidth = wrapper.clientWidth;
        const containerHeight = wrapper.clientHeight - counterOverlayHeight;
        const viewport = page.getViewport({ scale: 1 });

        // Calculate fit scales
        const scaleX = containerWidth / viewport.width;
        const scaleY = containerHeight / viewport.height;
        pdfFitScale = Math.min(scaleX, scaleY); // Fit entire page
        pdfFitWidthScale = scaleX; // Fit width only

        // Determine actual scale to use based on zoom mode
        let scale;
        if (pdfZoomMode === 'fit') {
            scale = pdfFitScale;
            wrapper.classList.add('fit-mode');
        } else if (pdfZoomMode === 'fit-width') {
            scale = pdfFitWidthScale;
            wrapper.classList.remove('fit-mode');
        } else {
            scale = pdfZoomScale;
            wrapper.classList.remove('fit-mode');
        }

        const scaledViewport = page.getViewport({ scale: scale });

        // Render at 2x resolution for sharper zoom/pinch
        const renderScale = 2;
        canvas.width = Math.floor(scaledViewport.width * renderScale);
        canvas.height = Math.floor(scaledViewport.height * renderScale);
        canvas.style.width = Math.floor(scaledViewport.width) + 'px';
        canvas.style.height = Math.floor(scaledViewport.height) + 'px';

        const hiResViewport = page.getViewport({ scale: scale * renderScale });
        const renderContext = {
            canvasContext: context,
            viewport: hiResViewport
        };

        await page.render(renderContext).promise;

        // Render annotation layer for clickable links
        const annotationLayer = document.getElementById('pdf-annotation-layer');
        annotationLayer.innerHTML = '';
        annotationLayer.style.width = Math.floor(scaledViewport.width) + 'px';
        annotationLayer.style.height = Math.floor(scaledViewport.height) + 'px';

        const annotations = await page.getAnnotations();
        for (const annotation of annotations) {
            if (annotation.subtype === 'Link' && annotation.url) {
                const rect = annotation.rect;
                // Transform PDF coordinates (origin bottom-left) to CSS coordinates (origin top-left)
                const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(rect);
                const link = document.createElement('a');
                link.href = annotation.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.style.left = `${x1 * scale}px`;
                link.style.top = `${(viewport.height - y2) * scale}px`;
                link.style.width = `${(x2 - x1) * scale}px`;
                link.style.height = `${(y2 - y1) * scale}px`;
                annotationLayer.appendChild(link);
            }
        }

        // Ensure scroll spacer exists for overlay clearance when zoomed
        let spacer = wrapper.querySelector('.pdf-scroll-spacer');
        if (!spacer) {
            spacer = document.createElement('div');
            spacer.className = 'pdf-scroll-spacer';
            const zoomOverlay = wrapper.querySelector('.pdf-zoom-overlay');
            wrapper.insertBefore(spacer, zoomOverlay);
        }
        if (pdfZoomMode === 'fit') {
            spacer.style.height = '0';
        } else {
            const overlayH = counterOverlay ? counterOverlay.offsetHeight : 0;
            const zoomOverlayEl = wrapper.querySelector('.pdf-zoom-overlay');
            const zoomH = zoomOverlayEl && getComputedStyle(zoomOverlayEl).display !== 'none'
                ? 100 + zoomOverlayEl.offsetHeight : 0;
            spacer.style.height = (Math.max(overlayH, zoomH, 150) + 20) + 'px';
        }

        // Update page info
        document.getElementById('page-info').textContent = `${pageNum} of ${totalPages}`;

        // Update zoom level display
        let zoomDisplay;
        if (pdfZoomMode === 'fit') {
            zoomDisplay = 'Fit';
        } else if (pdfZoomMode === 'fit-width') {
            zoomDisplay = '100%';
        } else {
            zoomDisplay = `${Math.round(pdfZoomScale * 100)}%`;
        }
        document.getElementById('zoom-level').value = zoomDisplay;

        // Update button states
        document.getElementById('prev-page-btn').disabled = pageNum <= 1;
        document.getElementById('next-page-btn').disabled = pageNum >= totalPages;

        // Update mobile bottom bar page info
        mobileBar.updatePageInfo();

    } catch (error) {
        console.error('Error rendering page:', error);
    }
}

function zoomIn() {
    // If in fit mode, convert to actual scale first
    if (pdfZoomMode === 'fit') {
        pdfZoomScale = pdfFitScale;
    } else if (pdfZoomMode === 'fit-width') {
        pdfZoomScale = pdfFitWidthScale;
    }
    pdfZoomMode = 'manual';
    pdfZoomScale = Math.min(pdfZoomScale + 0.1, 4.0);
    renderPage(currentPageNum);
    savePdfViewerState();
}

function zoomOut() {
    // If in fit mode, convert to actual scale first
    if (pdfZoomMode === 'fit') {
        pdfZoomScale = pdfFitScale;
    } else if (pdfZoomMode === 'fit-width') {
        pdfZoomScale = pdfFitWidthScale;
    }
    pdfZoomMode = 'manual';
    pdfZoomScale = Math.max(pdfZoomScale - 0.1, 0.25);
    renderPage(currentPageNum);
    savePdfViewerState();
}

function zoomFitPage() {
    pdfZoomMode = 'fit';
    renderPage(currentPageNum);
    savePdfViewerState();
}

function zoom100() {
    // 100% = fit width to screen
    pdfZoomMode = 'fit-width';
    renderPage(currentPageNum);
    savePdfViewerState();
}

function setZoomLevel(level) {
    pdfZoomMode = 'manual';
    pdfZoomScale = Math.min(Math.max(level, 0.25), 4.0);
    renderPage(currentPageNum);
    savePdfViewerState();
}

function getZoomDisplayString() {
    if (pdfZoomMode === 'fit') {
        return 'Fit';
    } else if (pdfZoomMode === 'fit-width') {
        return '100%';
    } else {
        return `${Math.round(pdfZoomScale * 100)}%`;
    }
}

// Per-pattern PDF viewer state persistence
function savePdfViewerState() {
    if (!currentPattern) return;
    const wrapper = document.querySelector('.pdf-viewer-wrapper');
    const pdfIframe = wrapper?.querySelector('.native-pdf-viewer');

    if (pdfIframe) {
        // Native PDF.js viewer
        const viewerApp = pdfIframe.contentWindow?.PDFViewerApplication;
        const container = viewerApp?.pdfViewer?.container;
        const state = {
            nativeZoom: viewerApp?.pdfViewer?.currentScaleValue || 'auto',
            scrollX: container?.scrollLeft || 0,
            scrollY: container?.scrollTop || 0
        };
        localStorage.setItem(`pdfViewerState_${currentPattern.id}`, JSON.stringify(state));
    } else {
        // Canvas-based viewer (mobile)
        const state = {
            zoomMode: pdfZoomMode,
            zoomScale: pdfZoomScale,
            scrollX: wrapper ? wrapper.scrollLeft : 0,
            scrollY: wrapper ? wrapper.scrollTop : 0
        };
        localStorage.setItem(`pdfViewerState_${currentPattern.id}`, JSON.stringify(state));
    }
}

function loadPdfViewerState(patternId) {
    const saved = localStorage.getItem(`pdfViewerState_${patternId}`);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            return null;
        }
    }
    return null;
}

async function changePage(delta) {
    // Native PDF.js viewer: navigate via API
    const wrapper = document.querySelector('.pdf-viewer-wrapper');
    const pdfIframe = wrapper?.querySelector('.native-pdf-viewer');
    if (pdfIframe) {
        const viewerApp = pdfIframe.contentWindow?.PDFViewerApplication;
        if (viewerApp) {
            const newPage = viewerApp.page + delta;
            if (newPage >= 1 && newPage <= viewerApp.pagesCount) {
                // Save viewport position before navigating
                const container = viewerApp.pdfViewer.container;
                const scrollLeft = container.scrollLeft;
                const currentPageView = viewerApp.pdfViewer.getPageView(viewerApp.page - 1);
                const withinPageTop = currentPageView?.div
                    ? container.scrollTop - currentPageView.div.offsetTop
                    : container.scrollTop;

                viewerApp.page = newPage;

                // Restore viewport position after navigation
                requestAnimationFrame(() => {
                    container.scrollLeft = scrollLeft;
                    if (viewerApp.pdfViewer.scrollMode === 0) {
                        // Continuous scroll: offset from new page's position
                        const newPageView = viewerApp.pdfViewer.getPageView(newPage - 1);
                        if (newPageView?.div) {
                            container.scrollTop = newPageView.div.offsetTop + withinPageTop;
                        }
                    } else {
                        // Page mode: restore directly
                        container.scrollTop = withinPageTop;
                    }
                });
            }
        }
        return;
    }

    // Canvas-based viewer (mobile)
    const newPage = currentPageNum + delta;

    if (newPage < 1 || newPage > totalPages) {
        return;
    }

    currentPageNum = newPage;
    await renderPage(currentPageNum);

    // Save current page to database
    if (currentPattern) {
        try {
            await fetch(`${API_URL}/api/patterns/${currentPattern.id}/page`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPage: currentPageNum })
            });
        } catch (error) {
            console.error('Error saving page:', error);
        }
    }
}

async function closePDFViewer() {
    releaseWakeLock();
    // Save PDF viewer state (zoom and scroll position) before closing
    savePdfViewerState();

    // Capture state needed for background saves before clearing
    const closingPattern = currentPattern;
    const closingPage = currentPageNum;
    const closingTimerSeconds = timerSeconds;

    // Stash timer in sessionStorage so reopening doesn't lose seconds to server lag
    if (closingPattern && closingTimerSeconds > 0) {
        sessionStorage.setItem(`timerSeconds_${closingPattern.id}`, closingTimerSeconds);
    }

    // Stop timer
    if (closingPattern && closingTimerSeconds > 0 && timerRunning) {
        timerRunning = false;
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    }

    // Collect annotation data from iframe before removing it
    let annotationData = null;
    const wrapper = document.querySelector('.pdf-viewer-wrapper');
    const pdfObject = wrapper.querySelector('.native-pdf-viewer');
    if (pdfObject) {
        try {
            const viewerApp = pdfObject.contentWindow?.PDFViewerApplication;
            if (viewerApp?.pdfDocument) {
                const currentMode = viewerApp.pdfViewer?.annotationEditorMode;
                if (currentMode && currentMode !== 0) {
                    viewerApp.pdfViewer.annotationEditorMode = { mode: 0 };
                    await new Promise(r => setTimeout(r, 100));
                }
                if (viewerApp.pdfDocument.annotationStorage?.size > 0) {
                    // Timeout to prevent saveDocument from blocking close
                    annotationData = await Promise.race([
                        viewerApp.pdfDocument.saveDocument(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
                    ]);
                }
            }
        } catch (e) { /* viewer may already be unloading or timed out */ }
        pdfObject.style.display = 'none';
        wrapper.querySelector('.pdf-page-container').style.display = '';
        const spacer = wrapper.querySelector('.pdf-scroll-spacer');
        if (spacer) spacer.style.display = '';
        const zoomOverlay = wrapper.querySelector('.pdf-zoom-overlay');
        if (zoomOverlay) zoomOverlay.style.display = '';
        const navControls = document.querySelector('.pdf-nav-controls');
        if (navControls) navControls.style.display = '';
        // Restore mobile page buttons
        const bar = document.getElementById('mobile-bottom-bar');
        if (bar) {
            const prev = bar.querySelector('.mobile-page-prev');
            const next = bar.querySelector('.mobile-page-next');
            if (prev) prev.style.display = '';
            if (next) next.style.display = '';
        }
    }

    // Clear viewing pattern from sessionStorage

    // Reset state
    resetTimerState();
    currentPattern = null;
    pdfDoc = null;
    lastUsedCounterId = null;

    // Navigate back immediately (no white flash)
    await navigateBack();
    loadCurrentPatterns();
    loadPatterns();

    // Save timer, page, and annotations in the background
    if (closingPattern) {
        if (closingTimerSeconds > 0) {
            fetch(`${API_URL}/api/patterns/${closingPattern.id}/timer`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timer_seconds: closingTimerSeconds })
            }).catch(() => {});
        }
        if (closingPage) {
            fetch(`${API_URL}/api/patterns/${closingPattern.id}/page`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPage: closingPage })
            }).catch(() => {});
        }
        if (annotationData) {
            pdfCacheVersions[closingPattern.id] = Date.now();
            const savePromise = fetch(`${API_URL}/api/patterns/${closingPattern.id}/file`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/pdf' },
                body: annotationData
            }).catch(() => {}).finally(() => {
                delete pendingAnnotationSaves[closingPattern.id];
            });
            pendingAnnotationSaves[closingPattern.id] = savePromise;
        }
    }
}

// PDF Edit Modal functionality
async function openPdfEditModal() {
    const modal = document.getElementById('pdf-edit-modal');

    // Populate form fields with current pattern data
    document.getElementById('pdf-edit-name').value = currentPattern.name || '';
    document.getElementById('pdf-edit-description').value = currentPattern.description || '';

    // Populate category dropdown
    const categoryContainer = document.getElementById('pdf-edit-category-container');
    categoryContainer.innerHTML = createCategoryDropdown('pdf-edit-category', currentPattern.category || getDefaultCategory());

    // Populate hashtags selector
    const hashtagsContainer = document.getElementById('pdf-edit-hashtags-container');
    const patternHashtagIds = (currentPattern.hashtags || []).map(h => h.id);
    hashtagsContainer.innerHTML = createHashtagSelector('pdf-edit-hashtags', patternHashtagIds);

    // Populate inventory tab selectors
    const pdfYarnContainer = document.getElementById('pdf-edit-yarns-container');
    const pdfHookContainer = document.getElementById('pdf-edit-hooks-container');
    try {
        const [yarnRes, hookRes] = await Promise.all([
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/yarns`),
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/hooks`)
        ]);
        const linkedYarns = yarnRes.ok ? await yarnRes.json() : [];
        const linkedHooks = hookRes.ok ? await hookRes.json() : [];
        pdfYarnContainer.innerHTML = createYarnSelector(linkedYarns.map(y => y.id));
        pdfHookContainer.innerHTML = createHookSelector(linkedHooks.map(h => h.id));
    } catch (e) {
        pdfYarnContainer.innerHTML = createYarnSelector([]);
        pdfHookContainer.innerHTML = createHookSelector([]);
    }
    updateInventoryTabBadge('pdf-edit');

    // Set existing thumbnail in selector
    if (currentPattern.thumbnail) {
        setThumbnailSelectorImage('pdf-edit', `${API_URL}${currentPattern.thumbnail}`);
    } else {
        clearThumbnailSelector('pdf-edit');
    }

    // Populate rating
    document.getElementById('pdf-edit-pattern-rating').innerHTML = ratingInputHtml('pdf-edit-pattern-rating-input', currentPattern.rating || 0);

    // Set current toggle state
    document.getElementById('pdf-edit-is-current').checked = currentPattern.is_current || false;

    // Reset delete button state with appropriate label
    const deleteBtn = document.getElementById('delete-pdf-pattern');
    resetDeleteButton(deleteBtn, enableDirectDelete ? 'Delete Pattern' : 'Archive Pattern');

    // Check if annotations exist and enable/disable revert button
    const revertBtn = document.getElementById('pdf-revert-btn');
    revertBtn.disabled = true;
    revertBtn.textContent = 'Revert Annotations';
    fetch(`${API_URL}/api/patterns/${currentPattern.id}/annotations`)
        .then(r => r.json())
        .then(data => { revertBtn.disabled = !data.hasAnnotations; })
        .catch(() => { revertBtn.disabled = true; });

    // Show "Copy to My Account" only when viewing someone else's pattern
    const patternOwner = currentPattern.owner_username || null;
    const isOwnPattern = !patternOwner
        || patternOwner === currentUser?.username
        || String(currentPattern.user_id) === String(currentUser?.id)
        || currentPattern.user_id == null;
    const copyToAccountBtn = document.getElementById('copy-to-account-btn');
    if (copyToAccountBtn) copyToAccountBtn.style.display = isOwnPattern ? 'none' : '';
    const dupPdfBtn = document.getElementById('duplicate-pdf-pattern');
    if (dupPdfBtn) dupPdfBtn.style.display = isOwnPattern ? '' : 'none';

    resetEditModalTab('pdf-edit');
    modal.style.display = 'flex';
}

function closePdfEditModal() {
    document.getElementById('pdf-edit-modal').style.display = 'none';
    // Reset delete button state
    const deleteBtn = document.getElementById('delete-pdf-pattern');
    resetDeleteButton(deleteBtn, enableDirectDelete ? 'Delete Pattern' : 'Archive Pattern');
}

async function deletePdfPattern() {
    if (!currentPattern) return;

    const btn = document.getElementById('delete-pdf-pattern');
    const actionText = enableDirectDelete ? 'Delete' : 'Archive';
    const actioningText = enableDirectDelete ? 'Deleting...' : 'Archiving...';

    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = `Confirm ${actionText}`;
        return;
    }

    // Second click - actually archive or delete
    btn.disabled = true;
    btn.textContent = actioningText;

    try {
        const url = enableDirectDelete
            ? `${API_URL}/api/patterns/${currentPattern.id}`
            : `${API_URL}/api/patterns/${currentPattern.id}/archive`;
        const method = enableDirectDelete ? 'DELETE' : 'POST';

        const response = await fetch(url, { method });

        if (response.ok) {
            showToast(enableDirectDelete ? 'Pattern deleted' : 'Pattern archived');
            closePdfEditModal();
            closePDFViewer();
            await loadPatterns();
            await loadCurrentPatterns();
            await loadCategories();
        } else {
            const error = await response.json();
            console.error(`Error ${actionText.toLowerCase()}ing pattern:`, error.error);
            resetDeleteButton(btn, `${actionText} Pattern`);
        }
    } catch (error) {
        console.error(`Error ${actionText.toLowerCase()}ing pattern:`, error);
        resetDeleteButton(btn, `${actionText} Pattern`);
    }
}

function resetDeleteButton(btn, text) {
    btn.disabled = false;
    btn.classList.remove('confirm-delete');
    btn.textContent = text;
}

// Pattern Info Modal
async function openPatternInfoModal() {
    if (!currentPattern) return;

    const modal = document.getElementById('pattern-info-modal');
    const grid = document.getElementById('pattern-info-grid');

    // Show loading state
    grid.innerHTML = '<p>Loading...</p>';
    modal.style.display = 'flex';

    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/info`);
        const info = await response.json();

        const formatFileSize = (bytes) => {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        };

        const rows = [
            { label: 'Name', value: info.name },
            { label: 'Category', value: info.category || 'Uncategorized' },
            { label: 'Rating', value: (currentPattern.rating || 0) > 0 ? ratingStarsHtml(currentPattern.rating) : '—' },
            { label: 'Type', value: info.pattern_type === 'markdown' ? 'Markdown' : 'PDF' },
            { label: 'Date Added', value: new Date(info.upload_date).toLocaleDateString() },
            { label: 'Date Started', value: info.started_date ? new Date(info.started_date).toLocaleDateString() : '—' },
            { label: 'Time Elapsed', value: formatTime(info.timer_seconds || 0) },
            { label: 'Completed', value: info.completed ? `Yes ${info.completed_date ? '(' + new Date(info.completed_date).toLocaleDateString() + ')' : ''}` : 'No' },
            { label: 'In Progress', value: info.is_current ? 'Yes' : 'No' },
            { label: 'File Size', value: formatFileSize(info.file_size) },
            { label: 'Filename', value: `<code>${escapeHtml(info.filename)}</code>` },
            { label: 'File Path', value: `<code>${escapeHtml(info.file_path)}</code>` }
        ];

        if (info.description) {
            rows.splice(2, 0, { label: 'Description', value: escapeHtml(info.description) });
        }

        // Add hashtags if available
        if (currentPattern.hashtags && currentPattern.hashtags.length > 0) {
            const hashtagsHtml = currentPattern.hashtags.map(h =>
                `<span class="info-hashtag">#${escapeHtml(h.name)}</span>`
            ).join(' ');
            rows.push({ label: 'Hashtags', value: hashtagsHtml });
        }

        // Add PDF metadata if available
        if (info.pdf_metadata) {
            const meta = info.pdf_metadata;
            if (meta.pageCount) rows.push({ label: 'Pages', value: meta.pageCount });
            if (meta.author) rows.push({ label: 'Author', value: escapeHtml(meta.author) });
            if (meta.title) rows.push({ label: 'PDF Title', value: escapeHtml(meta.title) });
            if (meta.subject) rows.push({ label: 'Subject', value: escapeHtml(meta.subject) });
            if (meta.creator) rows.push({ label: 'Creator', value: escapeHtml(meta.creator) });
            if (meta.producer) rows.push({ label: 'Producer', value: escapeHtml(meta.producer) });
        }

        grid.innerHTML = rows.map(row => `
            <span class="info-label">${row.label}</span>
            <span class="info-value">${row.value}</span>
        `).join('');

    } catch (error) {
        console.error('Error fetching pattern info:', error);
        grid.innerHTML = '<p>Error loading pattern info</p>';
    }
}

function closePatternInfoModal() {
    document.getElementById('pattern-info-modal').style.display = 'none';
}

// Close info modal when clicking outside
document.addEventListener('click', (e) => {
    const modal = document.getElementById('pattern-info-modal');
    if (e.target === modal) {
        closePatternInfoModal();
    }
});

// Close edit modal when clicking outside
document.addEventListener('click', (e) => {
    const modal = document.getElementById('pdf-edit-modal');
    if (e.target === modal) {
        closePdfEditModal();
    }
});

async function savePdfEdit() {
    const name = document.getElementById('pdf-edit-name').value;
    const category = getCategoryDropdownValue('pdf-edit-category');
    const description = document.getElementById('pdf-edit-description').value;
    const thumbnailFile = getThumbnailFile('pdf-edit');
    const hashtagIds = getSelectedHashtagIds('pdf-edit-hashtags');
    const isCurrent = document.getElementById('pdf-edit-is-current').checked;
    const rating = parseInt(document.getElementById('pdf-edit-pattern-rating-input')?.dataset.rating) || 0;

    if (!name.trim()) {
        alert('Pattern name is required');
        return;
    }

    try {
        // Update pattern metadata
        const metaResponse = await fetch(`${API_URL}/api/patterns/${currentPattern.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, description, rating })
        });

        // Update current status if changed
        if (isCurrent !== currentPattern.is_current) {
            await fetch(`${API_URL}/api/patterns/${currentPattern.id}/current`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isCurrent })
            });
        }

        if (!metaResponse.ok) {
            const error = await metaResponse.json();
            console.error('Error updating pattern metadata:', error.error);
            alert('Error updating pattern: ' + (error.error || 'Unknown error'));
            return;
        }

        // Update hashtags
        await fetch(`${API_URL}/api/patterns/${currentPattern.id}/hashtags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashtagIds })
        });

        // Update linked yarns
        const pdfYarnIds = getSelectedYarnIds('pdf-edit-yarns-container');
        const pdfHookIds = getSelectedHookIds('pdf-edit-hooks-container');
        await Promise.all([
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/yarns`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ yarnIds: pdfYarnIds })
            }),
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/hooks`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hookIds: pdfHookIds })
            })
        ]);

        // Handle thumbnail upload if provided
        if (thumbnailFile) {
            console.log('Uploading PDF edit thumbnail:', thumbnailFile.name, thumbnailFile.size, 'bytes');
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            const thumbResponse = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/thumbnail`, {
                method: 'POST',
                body: formData
            });
            if (!thumbResponse.ok) {
                console.error('Thumbnail upload failed:', await thumbResponse.text());
            } else {
                console.log('Thumbnail uploaded successfully');
            }
        }

        // Update currentPattern with new values
        currentPattern.name = name;
        currentPattern.category = category;
        currentPattern.description = description;
        currentPattern.is_current = isCurrent;
        if (isCurrent && !currentPattern.started_date) {
            currentPattern.started_date = new Date().toISOString();
        }
        currentPattern.rating = rating;

        // Update the viewer header
        document.getElementById('pdf-pattern-name').textContent = name;
        const mobilePatternName = document.getElementById('mobile-pattern-name');
        if (mobilePatternName) mobilePatternName.textContent = name;

        closePdfEditModal();

        // Reload patterns to reflect changes in the library
        await loadPatterns();
        await loadCurrentPatterns();
        await loadCategories();
    } catch (error) {
        console.error('Error saving pattern:', error);
        alert('Error saving pattern: ' + error.message);
    }
}

// Counter functionality
async function loadCounters(patternId) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${patternId}/counters`);
        counters = await response.json();

        // If no counters exist, create a default one
        if (counters.length === 0) {
            await addCounter('Counter');
        } else {
            // Set first counter as active if none selected
            if (!lastUsedCounterId || !counters.find(c => c.id === lastUsedCounterId)) {
                lastUsedCounterId = counters[0].id;
            }
            displayCounters();
        }
    } catch (error) {
        console.error('Error loading counters:', error);
    }
}

function applyCounterLayout() {
    const countersList = document.getElementById('counters-list');
    if (!countersList) return;
    const layout = localStorage.getItem('counterLayout') || 'stack';
    countersList.classList.toggle('scroll-layout', layout === 'scroll');
}

function counterIndicatorHTML(counter, size = 12) {
    if (counter.is_main) {
        return `<span class="counter-link-indicator counter-main-indicator"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>`;
    }
    if (counter.unlinked || !counters.some(c => c.is_main)) return '';
    return `<span class="counter-link-indicator"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg></span>`;
}

function displayCounters() {
    const countersList = document.getElementById('counters-list');

    if (counters.length === 0) {
        countersList.innerHTML = '<p style="text-align: center; color: #6b7280;">No counters. Click + to create one.</p>';
        return;
    }

    countersList.innerHTML = counters.map(counter => `
        <div class="counter-item${lastUsedCounterId === counter.id ? ' active' : ''}" data-counter-id="${counter.id}" onclick="selectCounter(${counter.id})">
            <div class="counter-name">
                <input type="text" value="${escapeHtml(counter.name)}" class="${counter.is_main ? 'is-main' : ''}"
                       onchange="updateCounterName(${counter.id}, this.value)"
                       onkeydown="if(event.key==='Enter'){this.blur()}"
                       onclick="event.stopPropagation(); selectCounter(${counter.id})"
                       onfocus="selectCounter(${counter.id})"
                       placeholder="Counter name">
                ${counterIndicatorHTML(counter)}
            </div>
            <div class="counter-main">
                <div class="counter-value">${counter.value}${counter.max_value ? `<span class="counter-max">/${counter.max_value}</span>` : ''}</div>
                <div class="counter-controls">
                    <button class="counter-btn counter-btn-minus" onclick="event.stopPropagation(); selectCounter(${counter.id}); decrementCounter(${counter.id})">−</button>
                    <button class="counter-btn counter-btn-plus" onclick="event.stopPropagation(); selectCounter(${counter.id}); incrementCounter(${counter.id})">+</button>
                    <button class="counter-btn counter-btn-reset" onclick="selectCounter(${counter.id}); handleCounterReset(event, ${counter.id})" title="Click twice to reset">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                        </svg>
                    </button>
                    <button class="counter-btn counter-btn-settings" onclick="event.stopPropagation(); toggleCounterSettings(${counter.id})" title="Counter settings">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="counter-settings-pane" style="display: none;">
                <label class="counter-settings-toggle${!counter.is_main && counters.some(c => c.is_main) ? ' disabled' : ''}" onclick="event.stopPropagation()"
                       ${!counter.is_main && counters.some(c => c.is_main) ? `title="'${escapeHtml(counters.find(c => c.is_main).name)}' is already the main counter"` : ''}>
                    <span>Main</span>
                    <div class="toggle-switch small">
                        <input type="checkbox" class="counter-main-toggle" ${counter.is_main ? 'checked' : ''}
                               ${!counter.is_main && counters.some(c => c.is_main) ? 'disabled' : ''}
                               onchange="toggleCounterMain(${counter.id}, this.checked)">
                        <span class="toggle-slider"></span>
                    </div>
                </label>
                <label class="counter-settings-toggle" onclick="event.stopPropagation()">
                    <span>Repeat</span>
                    <div class="toggle-switch small">
                        <input type="checkbox" class="counter-repeat-toggle" ${counter.max_value ? 'checked' : ''}
                               onchange="toggleCounterRepeat(${counter.id}, this.checked)">
                        <span class="toggle-slider"></span>
                    </div>
                </label>
                ${!counter.is_main && counters.some(c => c.is_main) ? `
                <button class="counter-link-btn ${counter.unlinked ? 'unlinked' : ''}" onclick="event.stopPropagation(); toggleCounterUnlink(${counter.id}, !${counter.unlinked})" title="${counter.unlinked ? 'Click to link to main counter' : 'Click to unlink from main counter'}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>
                </button>
                ` : ''}
                <div class="counter-settings-repeat" style="display: ${counter.max_value ? 'flex' : 'none'};" onclick="event.stopPropagation()">
                    <button class="repeat-step" onclick="stepRepeatValue(${counter.id}, -1)">−</button>
                    <input type="number" min="2" value="${counter.max_value || ''}" placeholder="—"
                           onchange="updateCounterMaxValue(${counter.id}, this.value)">
                    <button class="repeat-step" onclick="stepRepeatValue(${counter.id}, 1)">+</button>
                    <span class="repeat-label">rows</span>
                </div>
                <span class="counter-settings-spacer"></span>
                <button class="counter-settings-done" onclick="event.stopPropagation(); toggleCounterSettings(${counter.id})">Done</button>
                <button class="counter-settings-delete" onclick="selectCounter(${counter.id}); handleCounterDelete(event, ${counter.id})" title="Click twice to delete">Delete</button>
            </div>
        </div>
    `).join('');

    applyCounterLayout();
    mobileBar.update();
}

function toggleCounterSettings(counterId) {
    const item = document.querySelector(`.counter-item[data-counter-id="${counterId}"]`);
    if (!item) return;
    const name = item.querySelector('.counter-name');
    const main = item.querySelector('.counter-main');
    const pane = item.querySelector('.counter-settings-pane');
    if (!main || !pane) return;
    const showing = pane.style.display === 'none';
    // Close any other open settings panes first
    document.querySelectorAll('.counter-item').forEach(el => {
        if (el !== item) {
            const n = el.querySelector('.counter-name');
            const m = el.querySelector('.counter-main');
            const p = el.querySelector('.counter-settings-pane');
            if (n) n.style.display = '';
            if (m) m.style.display = '';
            if (p) p.style.display = 'none';
        }
    });
    if (name) name.style.display = showing ? 'none' : '';
    main.style.display = showing ? 'none' : '';
    pane.style.display = showing ? '' : 'none';
}

async function toggleCounterMain(counterId, enabled) {
    // Update local state immediately so closing the edit panel doesn't revert it
    const prev = counters.map(c => ({ id: c.id, is_main: c.is_main }));
    counters.forEach(c => c.is_main = false);
    const counter = counters.find(c => c.id === counterId);
    if (counter) counter.is_main = enabled;
    displayCounters();
    try {
        const response = await fetch(`${API_URL}/api/counters/${counterId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_main: enabled })
        });
        if (!response.ok) {
            // Revert on failure
            prev.forEach(p => { const c = counters.find(c => c.id === p.id); if (c) c.is_main = p.is_main; });
            displayCounters();
        }
    } catch (error) {
        console.error('Error toggling main counter:', error);
        prev.forEach(p => { const c = counters.find(c => c.id === p.id); if (c) c.is_main = p.is_main; });
        displayCounters();
    }
}

async function toggleCounterUnlink(counterId, enabled) {
    // Update local state immediately so closing the edit panel doesn't revert it
    const counter = counters.find(c => c.id === counterId);
    const prevState = counter?.unlinked;
    if (counter) counter.unlinked = enabled;
    try {
        const response = await fetch(`${API_URL}/api/counters/${counterId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unlinked: enabled })
        });
        if (response.ok) {
            // Update button state in-place
            const item = document.querySelector(`.counter-item[data-counter-id="${counterId}"]`);
            if (item) {
                const btn = item.querySelector('.counter-link-btn');
                if (btn) {
                    btn.classList.toggle('unlinked', enabled);
                    btn.title = enabled ? 'Click to link to main counter' : 'Click to unlink from main counter';
                    btn.setAttribute('onclick', `event.stopPropagation(); toggleCounterUnlink(${counterId}, ${!enabled})`);
                }
                // Update link indicator
                const nameDiv = item.querySelector('.counter-name');
                const indicator = nameDiv?.querySelector('.counter-link-indicator');
                if (enabled && indicator) {
                    indicator.remove();
                } else if (!enabled && !indicator && counter && nameDiv) {
                    nameDiv.insertAdjacentHTML('beforeend', counterIndicatorHTML(counter));
                }
            }
            // Update mobile counters
            if (typeof mobileBar !== 'undefined') mobileBar.update();
        } else {
            if (counter) counter.unlinked = prevState;
            displayCounters();
        }
    } catch (error) {
        console.error('Error toggling counter unlink:', error);
        if (counter) counter.unlinked = prevState;
        displayCounters();
    }
}

function toggleCounterRepeat(counterId, enabled) {
    const item = document.querySelector(`.counter-item[data-counter-id="${counterId}"]`);
    if (!item) return;
    const repeatLabel = item.querySelector('.counter-settings-repeat');
    if (repeatLabel) repeatLabel.style.display = enabled ? 'flex' : 'none';
    if (enabled) {
        const input = item.querySelector('.counter-settings-repeat input');
        if (input && !input.value) input.value = 2;
        updateCounterMaxValue(counterId, 2);
    } else {
        updateCounterMaxValue(counterId, '');
    }
}

function stepRepeatValue(counterId, delta) {
    const item = document.querySelector(`.counter-item[data-counter-id="${counterId}"]`);
    if (!item) return;
    const input = item.querySelector('.counter-settings-repeat input');
    if (!input) return;
    const current = parseInt(input.value) || 2;
    const newVal = Math.max(2, current + delta);
    input.value = newVal;
    updateCounterMaxValue(counterId, newVal);
}

async function updateCounterMaxValue(counterId, value) {
    const maxValue = parseInt(value) >= 2 ? parseInt(value) : null;
    try {
        const response = await fetch(`${API_URL}/api/counters/${counterId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_value: maxValue })
        });
        if (response.ok) {
            const updated = await response.json();
            const counter = counters.find(c => c.id === counterId);
            if (counter) {
                counter.max_value = updated.max_value;
                updateCounterDisplay(counterId);
            }
        }
    } catch (error) {
        console.error('Error updating counter max value:', error);
    }
}

function selectCounter(counterId) {
    if (lastUsedCounterId === counterId) return;
    lastUsedCounterId = counterId;
    // Update active class without full re-render
    document.querySelectorAll('.counter-item').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.counterId) === counterId);
    });
    mobileBar.update();
}

// Mobile Bar (top bar + bottom bar for mobile PDF viewer)
const mobileBar = (() => {
    let currentIndex = 0;
    let editingCounterId = null;
    let isResetting = false;

    function isMobile() {
        return window.matchMedia('(max-width: 768px), (max-height: 500px) and (max-width: 1024px)').matches;
    }

    function getPinnedIds() {
        const id = currentPattern?.id;
        if (!id) return [];
        try {
            const all = JSON.parse(localStorage.getItem('pinnedCounters') || '{}');
            return all[id] || [];
        } catch { return []; }
    }

    function setPinnedIds(ids) {
        const id = currentPattern?.id;
        if (!id) return;
        let all;
        try { all = JSON.parse(localStorage.getItem('pinnedCounters') || '{}'); }
        catch { all = {}; }
        if (ids.length > 0) {
            all[id] = ids;
        } else {
            delete all[id];
        }
        localStorage.setItem('pinnedCounters', JSON.stringify(all));
    }

    function isPinned(counterId) {
        return getPinnedIds().includes(counterId);
    }

    function getCarouselCounters() {
        return counters.filter(c => !isPinned(c.id));
    }

    function getPinnedCounters() {
        return counters.filter(c => isPinned(c.id));
    }

    function updateBarPadding() {
        requestAnimationFrame(() => {
            const bar = document.getElementById('mobile-bottom-bar');
            const wrapper = document.querySelector('.pdf-viewer-wrapper');
            if (bar && wrapper) {
                wrapper.style.paddingBottom = bar.offsetHeight + 'px';
            }
        });
    }

    function renderCounterHTML(counter, className, labelClass) {
        const nameStyle = counter.is_main ? ' style="color: var(--secondary-color)"' : '';
        const valueHTML = counter.max_value
            ? `${counter.value}<span class="counter-max">/${counter.max_value}</span>`
            : counter.value;
        return `<div class="${className}" data-counter-id="${counter.id}">
            <div class="mobile-bar-btn mobile-counter-dec">−</div>
            <div class="${labelClass}">
                <span class="mobile-counter-name"${nameStyle}>${escapeHtml(counter.name || 'Counter')}</span>
                <span class="mobile-counter-value-row">
                    <span class="mobile-counter-value">${valueHTML}</span>
                    ${counterIndicatorHTML(counter, 8)}
                </span>
            </div>
            <div class="mobile-bar-btn mobile-counter-inc">+</div>
        </div>`;
    }

    function updateCounterInPlace(container, counter, selector) {
        const el = container.querySelector(`${selector}[data-counter-id="${counter.id}"]`);
        if (!el) return;
        const nameEl = el.querySelector('.mobile-counter-name');
        const valEl = el.querySelector('.mobile-counter-value');
        if (nameEl) {
            nameEl.textContent = counter.name || 'Counter';
            nameEl.style.color = counter.is_main ? 'var(--secondary-color)' : '';
        }
        if (valEl) valEl.innerHTML = counter.max_value
            ? `${counter.value}<span class="counter-max">/${counter.max_value}</span>`
            : counter.value;
        // Update link/main indicator
        const valueRow = el.querySelector('.mobile-counter-value-row');
        if (valueRow) {
            const existing = valueRow.querySelector('.counter-link-indicator');
            if (existing) existing.remove();
            const html = counterIndicatorHTML(counter, 8);
            if (html) valueRow.insertAdjacentHTML('beforeend', html);
        }
    }

    function update() {
        const bar = document.getElementById('mobile-bottom-bar');
        if (!bar || !isMobile()) return;

        const counterSection = bar.querySelector('.mobile-bar-counter');
        const addBtn = bar.querySelector('.mobile-counter-add');
        const dotsContainer = bar.querySelector('.mobile-counter-dots');
        const pinnedContainer = bar.querySelector('.mobile-pinned-counters');

        if (counters.length === 0) {
            if (counterSection) counterSection.style.display = 'none';
            if (addBtn) addBtn.style.display = '';
            if (dotsContainer) dotsContainer.classList.remove('visible');
            if (pinnedContainer) pinnedContainer.classList.remove('visible');
            updateBarPadding();
            return;
        }

        if (addBtn) addBtn.style.display = 'none';

        const pinned = getPinnedCounters();
        const carousel = getCarouselCounters();

        // --- Render pinned counters ---
        if (pinnedContainer) {
            if (pinned.length > 0) {
                pinnedContainer.classList.add('visible');
                const existingPinned = pinnedContainer.querySelectorAll('.mobile-pinned-counter');
                const needsPinnedRender = existingPinned.length !== pinned.length ||
                    pinned.some((c, i) => existingPinned[i]?.dataset.counterId != c.id);

                if (needsPinnedRender) {
                    pinnedContainer.innerHTML = pinned.map(c =>
                        renderCounterHTML(c, 'mobile-pinned-counter', 'mobile-pinned-counter-label')
                    ).join('');
                } else {
                    pinned.forEach(c => updateCounterInPlace(pinnedContainer, c, '.mobile-pinned-counter'));
                }
            } else {
                pinnedContainer.classList.remove('visible');
                pinnedContainer.innerHTML = '';
            }
        }

        // --- Render carousel counters (infinite 3-card layout) ---
        if (carousel.length > 0) {
            if (counterSection) counterSection.style.display = '';

            // Clamp index to carousel bounds
            if (currentIndex >= carousel.length) currentIndex = carousel.length - 1;
            if (currentIndex < 0) currentIndex = 0;

            // Sync with active counter (only if it's in the carousel)
            const activeIdx = carousel.findIndex(c => c.id === lastUsedCounterId);
            if (activeIdx >= 0) currentIndex = activeIdx;

            const cardsContainer = bar.querySelector('.mobile-counter-cards');
            if (cardsContainer) {
                if (carousel.length === 1) {
                    // Single card — no scrolling
                    const existing = cardsContainer.querySelector('.mobile-counter-card');
                    if (!existing || existing.dataset.counterId != carousel[0].id) {
                        cardsContainer.innerHTML = renderCounterHTML(carousel[0], 'mobile-counter-card', 'mobile-counter-card-label');
                    } else {
                        updateCounterInPlace(cardsContainer, carousel[0], '.mobile-counter-card');
                    }
                } else {
                    // Render 3 cards: [prev, current, next] for infinite scroll
                    const prevIdx = (currentIndex - 1 + carousel.length) % carousel.length;
                    const nextIdx = (currentIndex + 1) % carousel.length;
                    const triple = [carousel[prevIdx], carousel[currentIndex], carousel[nextIdx]];

                    const existingCards = cardsContainer.querySelectorAll('.mobile-counter-card');
                    const needsRender = existingCards.length !== 3 ||
                        triple.some((c, i) => existingCards[i]?.dataset.counterId != c.id);

                    if (needsRender) {
                        isResetting = true;
                        cardsContainer.innerHTML = triple.map(c =>
                            renderCounterHTML(c, 'mobile-counter-card', 'mobile-counter-card-label')
                        ).join('');
                        const cardWidth = cardsContainer.offsetWidth;
                        cardsContainer.scrollLeft = cardWidth; // center card
                        requestAnimationFrame(() => { isResetting = false; });
                    } else {
                        // In-place update by position (handles duplicate IDs for 2-card case)
                        existingCards.forEach((card, i) => {
                            const counter = triple[i];
                            const nameEl = card.querySelector('.mobile-counter-name');
                            const valEl = card.querySelector('.mobile-counter-value');
                            if (nameEl) {
                                nameEl.textContent = counter.name || 'Counter';
                                nameEl.style.color = counter.is_main ? 'var(--secondary-color)' : '';
                            }
                            if (valEl) valEl.innerHTML = counter.max_value
                                ? `${counter.value}<span class="counter-max">/${counter.max_value}</span>`
                                : counter.value;
                            // Update link indicator
                            const valueRow = card.querySelector('.mobile-counter-value-row');
                            if (valueRow) {
                                const existing = valueRow.querySelector('.counter-link-indicator');
                                if (existing) existing.remove();
                                const html = counterIndicatorHTML(counter, 8);
                                if (html) valueRow.insertAdjacentHTML('beforeend', html);
                            }
                        });
                    }
                }
            }

            // Show/hide nav arrows
            const prev = bar.querySelector('.mobile-counter-prev');
            const next = bar.querySelector('.mobile-counter-next');
            if (prev) prev.classList.toggle('hidden', carousel.length <= 1);
            if (next) next.classList.toggle('hidden', carousel.length <= 1);
        } else {
            if (counterSection) counterSection.style.display = 'none';
            // Clear leftover cards so hidden container can't intercept swipes
            const cardsContainer = bar.querySelector('.mobile-counter-cards');
            if (cardsContainer) cardsContainer.innerHTML = '';
        }

        // Update dot indicators
        if (dotsContainer) {
            if (carousel.length > 1) {
                dotsContainer.classList.add('visible');
                dotsContainer.innerHTML = carousel.map((_, i) =>
                    `<span class="mobile-counter-dot${i === currentIndex ? ' active' : ''}"></span>`
                ).join('');
            } else {
                dotsContainer.classList.remove('visible');
                dotsContainer.innerHTML = '';
            }
        }

        updateBarPadding();
        updatePageInfo();
    }

    function updatePageInfo() {
        // Update page info in top bar
        document.querySelectorAll('.mobile-page-info').forEach(el => {
            el.textContent = `${currentPageNum} / ${totalPages}`;
        });
        // Update page button states in bottom bar
        const bar = document.getElementById('mobile-bottom-bar');
        if (!bar) return;
        const prevBtn = bar.querySelector('.mobile-page-prev');
        const nextBtn = bar.querySelector('.mobile-page-next');
        if (prevBtn) prevBtn.disabled = currentPageNum <= 1;
        if (nextBtn) nextBtn.disabled = currentPageNum >= totalPages;
    }

    function nav(delta) {
        const carousel = getCarouselCounters();
        if (carousel.length <= 1) return;
        const bar = document.getElementById('mobile-bottom-bar');
        const cardsContainer = bar?.querySelector('.mobile-counter-cards');
        if (!cardsContainer) return;
        const cardWidth = cardsContainer.offsetWidth;
        // Scroll to prev (pos 0) or next (pos 2) — scroll handler updates state after
        cardsContainer.scrollTo({ left: (delta < 0 ? 0 : 2) * cardWidth, behavior: 'smooth' });
    }

    function getEditingCounter() {
        return editingCounterId ? counters.find(c => c.id === editingCounterId) : null;
    }

    function toggleEdit(show) {
        const bar = document.getElementById('mobile-bottom-bar');
        if (!bar) return;
        const editPanel = bar.querySelector('.mobile-bar-edit');
        const maxValueInput = bar.querySelector('.mobile-edit-max-value');
        const mainToggle = bar.querySelector('.mobile-edit-main');
        const repeatToggle = bar.querySelector('.mobile-edit-repeat-toggle');
        const repeatLabel = bar.querySelector('.mobile-edit-repeat');
        if (show) {
            const counter = getEditingCounter();
            if (!counter) return;
            bar.querySelector('.mobile-edit-name').value = counter.name || '';
            if (maxValueInput) maxValueInput.value = counter.max_value || '';
            if (mainToggle) {
                mainToggle.checked = !!counter.is_main;
                const otherIsMain = !counter.is_main && counters.some(c => c.is_main);
                mainToggle.disabled = otherIsMain;
                const mainLabel = bar.querySelector('.mobile-edit-main-label');
                if (mainLabel) {
                    mainLabel.classList.toggle('disabled', otherIsMain);
                    mainLabel.title = otherIsMain ? `'${counters.find(c => c.is_main).name}' is already the main counter` : '';
                }
            }
            // Unlink button — show only on non-main counters when a main exists
            const unlinkBtn = bar.querySelector('.mobile-edit-unlink-btn');
            const showUnlink = !counter.is_main && counters.some(c => c.is_main);
            if (unlinkBtn) {
                unlinkBtn.style.display = showUnlink ? 'flex' : 'none';
                unlinkBtn.classList.toggle('unlinked', !!counter.unlinked);
                unlinkBtn.title = counter.unlinked ? 'Click to link to main counter' : 'Click to unlink from main counter';
            }
            if (repeatToggle) repeatToggle.checked = !!counter.max_value;
            if (repeatLabel) repeatLabel.style.display = counter.max_value ? 'flex' : 'none';
            // Pin button state — disable when action would leave carousel or pinned list empty
            const pinBtn = bar.querySelector('.mobile-edit-pin');
            if (pinBtn) {
                const pinned = isPinned(counter.id);
                const carousel = getCarouselCounters();
                const cantUse = (!pinned && carousel.length <= 1) || (pinned && carousel.length === 0);
                pinBtn.style.display = '';
                pinBtn.classList.toggle('pinned', pinned);
                pinBtn.disabled = cantUse;
                pinBtn.style.opacity = cantUse ? '0.35' : '';
                pinBtn.title = pinned ? 'Unpin counter' : 'Pin counter above';
            }
            // Position indicator
            const posEl = bar.querySelector('.mobile-edit-pos');
            if (posEl) {
                if (isPinned(counter.id)) {
                    posEl.textContent = 'Pinned';
                } else {
                    const carousel = getCarouselCounters();
                    posEl.textContent = carousel.length > 1 ? `${currentIndex + 1}/${carousel.length}` : '';
                }
            }
            editPanel.style.display = '';
        } else {
            const counter = getEditingCounter();
            if (counter) {
                // Save name if changed
                const nameInput = bar.querySelector('.mobile-edit-name');
                if (nameInput.value !== counter.name) {
                    counter.name = nameInput.value;
                    updateCounterName(counter.id, nameInput.value);
                }
            }
            editingCounterId = null;
            editPanel.style.display = 'none';
            update();
            displayCounters();
        }
    }

    function init() {
        const bar = document.getElementById('mobile-bottom-bar');
        const topBar = document.querySelector('.mobile-top-bar');
        if (!bar && !topBar) return;

        // --- Top bar ---
        if (topBar) {
            const backBtn = document.getElementById('mobile-back-btn');
            const timerBtn = document.getElementById('mobile-timer-btn');
            const menuBtn = document.getElementById('mobile-menu-btn');
            const menu = document.getElementById('mobile-menu');

            if (backBtn) backBtn.addEventListener('click', closePDFViewer);
            if (timerBtn) timerBtn.addEventListener('click', toggleTimer);

            // Hamburger menu toggle
            if (menuBtn && menu) {
                menuBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
                });

                document.addEventListener('click', (e) => {
                    if (!menuBtn.contains(e.target) && !menu.contains(e.target)) {
                        menu.style.display = 'none';
                    }
                });
            }

            // Menu items
            const notesBtn = document.getElementById('mobile-notes-btn');
            const editBtn = document.getElementById('mobile-edit-btn');
            const infoBtn = document.getElementById('mobile-info-btn');
            const autoTimerCheckbox = document.getElementById('mobile-auto-timer-checkbox');
            const timerResetBtn = document.getElementById('mobile-timer-reset-btn');

            if (notesBtn) notesBtn.addEventListener('click', () => {
                menu.style.display = 'none';
                toggleNotesPopover();
            });
            if (editBtn) editBtn.addEventListener('click', () => {
                menu.style.display = 'none';
                openPdfEditModal();
            });
            if (infoBtn) infoBtn.addEventListener('click', () => {
                menu.style.display = 'none';
                openPatternInfoModal();
            });
            if (autoTimerCheckbox) {
                autoTimerCheckbox.addEventListener('change', toggleAutoTimer);
            }
            if (timerResetBtn) timerResetBtn.addEventListener('click', () => {
                if (timerResetConfirming) {
                    // Second click - reset and close menu
                    menu.style.display = 'none';
                }
                handleTimerReset();
            });
        }

        // --- Bottom bar ---
        if (bar) {
            // Page navigation
            bar.querySelector('.mobile-page-prev').addEventListener('click', () => changePage(-1));
            bar.querySelector('.mobile-page-next').addEventListener('click', () => changePage(1));

            // Add counter button (shown when no counters exist)
            bar.querySelector('.mobile-counter-add').addEventListener('click', async () => {
                await addCounter('Counter');
                update();
            });

            // Counter arrow navigation — scroll handler updates state after animation
            bar.querySelector('.mobile-counter-prev').addEventListener('click', () => nav(-1));
            bar.querySelector('.mobile-counter-next').addEventListener('click', () => nav(1));

            // Scroll-snap sync — detect which card is snapped after swipe
            const cardsContainer = bar.querySelector('.mobile-counter-cards');
            if (cardsContainer) {
                // Update dots eagerly during scroll (no delay)
                const dotsContainer = bar.querySelector('.mobile-counter-dots');
                let lastEagerIndex = null;
                cardsContainer.addEventListener('scroll', () => {
                    if (isResetting) return;
                    const carousel = getCarouselCounters();
                    if (carousel.length <= 1 || !dotsContainer) return;
                    const cardWidth = cardsContainer.offsetWidth;
                    if (cardWidth === 0) return;
                    const pos = cardsContainer.scrollLeft / cardWidth;
                    let targetIndex = currentIndex;
                    if (pos < 0.5) targetIndex = (currentIndex - 1 + carousel.length) % carousel.length;
                    else if (pos > 1.5) targetIndex = (currentIndex + 1) % carousel.length;
                    dotsContainer.querySelectorAll('.mobile-counter-dot').forEach((dot, i) => {
                        dot.classList.toggle('active', i === targetIndex);
                    });
                    // Update edit panel eagerly during swipe
                    if (targetIndex !== lastEagerIndex) {
                        lastEagerIndex = targetIndex;
                        editingCounterId = carousel[targetIndex].id;
                        const editPanel = bar.querySelector('.mobile-bar-edit');
                        if (editPanel && editPanel.style.display !== 'none') toggleEdit(true);
                    }
                }, { passive: true });

                // Re-render cards when scroll settles
                cardsContainer.addEventListener('scrollend', () => {
                    if (isResetting) return;
                    const carousel = getCarouselCounters();
                    if (carousel.length <= 1) return;
                    const cardWidth = cardsContainer.offsetWidth;
                    if (cardWidth === 0) return;
                    const pos = Math.round(cardsContainer.scrollLeft / cardWidth);
                    if (pos === 1) return;
                    if (pos === 0) {
                        currentIndex = (currentIndex - 1 + carousel.length) % carousel.length;
                    } else if (pos >= 2) {
                        currentIndex = (currentIndex + 1) % carousel.length;
                    }
                    lastUsedCounterId = carousel[currentIndex].id;
                    editingCounterId = carousel[currentIndex].id;
                    lastEagerIndex = null;
                    displayCounters();
                    update();
                    const editPanel = bar.querySelector('.mobile-bar-edit');
                    if (editPanel && editPanel.style.display !== 'none') toggleEdit(true);
                });
            }

            // Counter inc/dec + label tap via event delegation (carousel cards)
            bar.querySelector('.mobile-counter-cards')?.addEventListener('click', (e) => {
                const card = e.target.closest('.mobile-counter-card');
                if (!card) return;
                const counterId = parseInt(card.dataset.counterId);
                if (e.target.closest('.mobile-counter-inc')) {
                    incrementCounter(counterId);
                } else if (e.target.closest('.mobile-counter-dec')) {
                    decrementCounter(counterId);
                } else if (e.target.closest('.mobile-counter-card-label')) {
                    editingCounterId = counterId;
                    const editPanel = bar.querySelector('.mobile-bar-edit');
                    toggleEdit(editPanel.style.display === 'none');
                }
            });

            // Pinned counter inc/dec + label tap via event delegation
            bar.querySelector('.mobile-pinned-counters')?.addEventListener('click', (e) => {
                const row = e.target.closest('.mobile-pinned-counter');
                if (!row) return;
                const counterId = parseInt(row.dataset.counterId);
                if (e.target.closest('.mobile-counter-inc')) {
                    incrementCounter(counterId);
                } else if (e.target.closest('.mobile-counter-dec')) {
                    decrementCounter(counterId);
                } else if (e.target.closest('.mobile-pinned-counter-label')) {
                    const editPanel = bar.querySelector('.mobile-bar-edit');
                    const wasOpen = editPanel.style.display !== 'none';
                    const switching = editingCounterId !== counterId;
                    editingCounterId = counterId;
                    toggleEdit(!wasOpen || switching);
                }
            });

            // Edit panel
            bar.querySelector('.mobile-edit-done').addEventListener('click', () => toggleEdit(false));

            // Pin/Unpin button
            bar.querySelector('.mobile-edit-pin')?.addEventListener('click', () => {
                const counter = getEditingCounter();
                if (!counter) return;
                const ids = getPinnedIds();
                if (ids.includes(counter.id)) {
                    setPinnedIds(ids.filter(id => id !== counter.id));
                } else {
                    ids.push(counter.id);
                    setPinnedIds(ids);
                }
                toggleEdit(false);
            });

            // Main toggle — save immediately
            bar.querySelector('.mobile-edit-main')?.addEventListener('change', (e) => {
                const counter = getEditingCounter();
                if (counter) toggleCounterMain(counter.id, e.target.checked);
            });

            // Show tooltip on tap when main toggle is disabled
            bar.querySelector('.mobile-edit-main-label')?.addEventListener('click', (e) => {
                const toggle = bar.querySelector('.mobile-edit-main');
                if (!toggle?.disabled) return;
                const label = bar.querySelector('.mobile-edit-main-label');
                if (!label?.title) return;
                let tip = label.querySelector('.mobile-tooltip');
                if (tip) return; // already showing
                tip = document.createElement('span');
                tip.className = 'mobile-tooltip';
                tip.textContent = label.title;
                label.appendChild(tip);
                setTimeout(() => tip.remove(), 2000);
            });

            // Unlink button — save immediately
            bar.querySelector('.mobile-edit-unlink-btn')?.addEventListener('click', async () => {
                const counter = getEditingCounter();
                if (counter) {
                    const newState = !counter.unlinked;
                    await toggleCounterUnlink(counter.id, newState);
                    const btn = bar.querySelector('.mobile-edit-unlink-btn');
                    if (btn) {
                        btn.classList.toggle('unlinked', newState);
                        btn.title = newState ? 'Click to link to main counter' : 'Click to unlink from main counter';
                    }
                }
            });

            // Repeat toggle shows/hides the repeat input
            const mobileRepeatToggle = bar.querySelector('.mobile-edit-repeat-toggle');
            const mobileRepeatLabel = bar.querySelector('.mobile-edit-repeat');
            const mobileMaxInput = bar.querySelector('.mobile-edit-max-value');
            if (mobileRepeatToggle) {
                mobileRepeatToggle.addEventListener('change', () => {
                    const counter = getEditingCounter();
                    if (mobileRepeatLabel) mobileRepeatLabel.style.display = mobileRepeatToggle.checked ? 'flex' : 'none';
                    if (mobileRepeatToggle.checked) {
                        if (mobileMaxInput && !mobileMaxInput.value) mobileMaxInput.value = 2;
                        if (counter) updateCounterMaxValue(counter.id, 2);
                    } else {
                        if (mobileMaxInput) mobileMaxInput.value = '';
                        if (counter) updateCounterMaxValue(counter.id, '');
                    }
                });
            }
            // Repeat stepper buttons
            bar.querySelector('.mobile-edit-repeat-dec')?.addEventListener('click', () => {
                const counter = getEditingCounter();
                if (mobileMaxInput) {
                    const val = Math.max(2, (parseInt(mobileMaxInput.value) || 2) - 1);
                    mobileMaxInput.value = val;
                    if (counter) updateCounterMaxValue(counter.id, val);
                }
            });
            bar.querySelector('.mobile-edit-repeat-inc')?.addEventListener('click', () => {
                const counter = getEditingCounter();
                if (mobileMaxInput) {
                    const val = (parseInt(mobileMaxInput.value) || 2) + 1;
                    mobileMaxInput.value = val;
                    if (counter) updateCounterMaxValue(counter.id, val);
                }
            });
            if (mobileMaxInput) {
                mobileMaxInput.addEventListener('change', () => {
                    const counter = getEditingCounter();
                    if (counter) updateCounterMaxValue(counter.id, mobileMaxInput.value);
                });
            }
            bar.querySelector('.mobile-edit-add').addEventListener('click', async () => {
                await addCounter('Counter');
                toggleEdit(false);
            });
            bar.querySelector('.mobile-edit-reset').addEventListener('click', async () => {
                const counter = getEditingCounter();
                if (!counter) return;
                await resetCounter(counter.id);
                update();
            });
            bar.querySelector('.mobile-edit-delete').addEventListener('click', async () => {
                const counter = getEditingCounter();
                if (!counter) return;
                // Remove from pinned IDs if pinned
                const ids = getPinnedIds();
                if (ids.includes(counter.id)) {
                    setPinnedIds(ids.filter(id => id !== counter.id));
                }
                await deleteCounter(counter.id);
                if (counters.length === 0) {
                    toggleEdit(false);
                } else {
                    editingCounterId = null;
                    update();
                    // Open edit panel for next counter in carousel if available
                    const carousel = getCarouselCounters();
                    if (carousel.length > 0) {
                        if (currentIndex >= carousel.length) currentIndex = carousel.length - 1;
                        editingCounterId = carousel[currentIndex].id;
                        toggleEdit(true);
                    } else {
                        toggleEdit(false);
                    }
                }
            });
            bar.querySelector('.mobile-edit-name').addEventListener('change', (e) => {
                const counter = getEditingCounter();
                if (counter) updateCounterName(counter.id, e.target.value);
            });
        }

        // Visual feedback for bottom bar buttons via event delegation
        if (bar) {
            bar.addEventListener('touchstart', (e) => {
                const btn = e.target.closest('.mobile-bar-btn, .mobile-bar-nav');
                if (btn) {
                    btn.classList.add('pressed');
                }
            }, { passive: true });
            bar.addEventListener('touchend', () => {
                bar.querySelectorAll('.pressed').forEach(el => el.classList.remove('pressed'));
            });
            bar.addEventListener('touchcancel', () => {
                bar.querySelectorAll('.pressed').forEach(el => el.classList.remove('pressed'));
            });
        }
    }

    return { init, update, updatePageInfo };
})();

async function addCounter(defaultName = 'New Counter') {
    if (!currentPattern) return;

    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/counters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: defaultName, value: 0 })
        });

        if (response.ok) {
            const newCounter = await response.json();
            counters.push(newCounter);
            lastUsedCounterId = newCounter.id;
            displayCounters();

            // Focus the new counter's name input
            const newCounterEl = document.querySelector(`.counter-item[data-counter-id="${newCounter.id}"] input`);
            if (newCounterEl) {
                newCounterEl.focus();
                newCounterEl.select();
            }
        }
    } catch (error) {
        console.error('Error adding counter:', error);
    }
}

function updateCounterDisplay(counterId) {
    const counter = counters.find(c => c.id === counterId);
    if (!counter) return;
    // Update desktop value in-place
    const item = document.querySelector(`.counter-item[data-counter-id="${counterId}"]`);
    if (item) {
        const valEl = item.querySelector('.counter-value');
        if (valEl) valEl.innerHTML = counter.max_value ? `${counter.value}<span class="counter-max">/${counter.max_value}</span>` : `${counter.value}`;
    }
    // Update mobile bar
    mobileBar.update();
}

async function incrementCounter(counterId) {
    try {
        lastUsedCounterId = counterId;
        const response = await fetch(`${API_URL}/api/counters/${counterId}/increment`, {
            method: 'POST'
        });

        if (response.ok) {
            const data = await response.json();
            const updated = data.counter || data;
            const counter = counters.find(c => c.id === counterId);
            if (counter) {
                counter.value = updated.value;
                updateCounterDisplay(counterId);
            }
            if (data.main_counter) {
                const main = counters.find(c => c.id === data.main_counter.id);
                if (main) {
                    main.value = data.main_counter.value;
                    updateCounterDisplay(main.id);
                }
            }
        }
    } catch (error) {
        console.error('Error incrementing counter:', error);
    }
}

async function decrementCounter(counterId) {
    try {
        lastUsedCounterId = counterId;
        const response = await fetch(`${API_URL}/api/counters/${counterId}/decrement`, {
            method: 'POST'
        });

        if (response.ok) {
            const data = await response.json();
            const updated = data.counter || data;
            const counter = counters.find(c => c.id === counterId);
            if (counter) {
                counter.value = updated.value;
                updateCounterDisplay(counterId);
            }
            if (data.main_counter) {
                const main = counters.find(c => c.id === data.main_counter.id);
                if (main) {
                    main.value = data.main_counter.value;
                    updateCounterDisplay(main.id);
                }
            }
        }
    } catch (error) {
        console.error('Error decrementing counter:', error);
    }
}

// Keyboard shortcut helpers for counters
function incrementLastUsedCounter() {
    const counterId = getActiveCounterId();
    if (counterId) {
        incrementCounter(counterId);
    }
}

function decrementLastUsedCounter() {
    const counterId = getActiveCounterId();
    if (counterId) {
        decrementCounter(counterId);
    }
}

function getActiveCounterId() {
    // If we have a last used counter and it still exists, use that
    if (lastUsedCounterId && counters.find(c => c.id === lastUsedCounterId)) {
        return lastUsedCounterId;
    }

    // Otherwise, use the first counter
    if (counters.length > 0) {
        lastUsedCounterId = counters[0].id;
        return lastUsedCounterId;
    }

    return null;
}

function selectNextCounter() {
    if (counters.length === 0) return;

    const currentIndex = counters.findIndex(c => c.id === lastUsedCounterId);
    const nextIndex = (currentIndex + 1) % counters.length;
    lastUsedCounterId = counters[nextIndex].id;
    displayCounters();
}

// Counter confirmation handlers
function handleCounterReset(event, counterId) {
    event.stopPropagation();
    event.preventDefault();
    const btn = event.currentTarget;

    if (btn.classList.contains('confirming')) {
        btn.classList.remove('confirming');
        resetCounter(counterId);
    } else {
        document.querySelectorAll('.counter-btn-reset.confirming, .counter-btn-delete.confirming').forEach(b => {
            b.classList.remove('confirming');
        });
        btn.classList.add('confirming');
        setTimeout(() => {
            btn.classList.remove('confirming');
        }, 3000);
    }
}

function handleCounterDelete(event, counterId) {
    event.stopPropagation();
    event.preventDefault();
    const btn = event.currentTarget;

    if (btn.classList.contains('confirming')) {
        btn.classList.remove('confirming');
        btn.textContent = 'Delete';
        deleteCounter(counterId);
    } else {
        document.querySelectorAll('.counter-btn-reset.confirming, .counter-btn-delete.confirming, .counter-settings-delete.confirming').forEach(b => {
            b.classList.remove('confirming');
            if (b.classList.contains('counter-settings-delete')) b.textContent = 'Delete';
        });
        btn.classList.add('confirming');
        btn.textContent = 'Confirm?';
        setTimeout(() => {
            btn.classList.remove('confirming');
            btn.textContent = 'Delete';
        }, 3000);
    }
}

async function resetCounter(counterId) {
    try {
        const response = await fetch(`${API_URL}/api/counters/${counterId}/reset`, {
            method: 'POST'
        });

        if (response.ok) {
            const updated = await response.json();
            const counter = counters.find(c => c.id === counterId);
            if (counter) {
                counter.value = updated.value;
                displayCounters();
            }
        }
    } catch (error) {
        console.error('Error resetting counter:', error);
    }
}

async function deleteCounter(counterId) {
    try {
        const response = await fetch(`${API_URL}/api/counters/${counterId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            counters = counters.filter(c => c.id !== counterId);

            // Clear lastUsedCounterId if we deleted that counter
            if (lastUsedCounterId === counterId) {
                lastUsedCounterId = null;
            }

            displayCounters();
        }
    } catch (error) {
        console.error('Error deleting counter:', error);
    }
}

async function updateCounterName(counterId, newName) {
    if (!newName.trim()) return;

    try {
        const response = await fetch(`${API_URL}/api/counters/${counterId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });

        if (response.ok) {
            const counter = counters.find(c => c.id === counterId);
            if (counter) {
                counter.name = newName;
            }
        }
    } catch (error) {
        console.error('Error updating counter name:', error);
    }
}

// Notes functionality
let currentNotes = '';
let notesAutoSaveTimeout = null;
let clearConfirmPending = false;

function toggleNotesPopover() {
    const popover = document.getElementById('notes-popover');
    if (popover.style.display === 'none') {
        openNotesPopover();
    } else {
        closeNotesPopover();
    }
}

async function openNotesPopover() {
    const popover = document.getElementById('notes-popover');
    const editor = document.getElementById('notes-editor');

    if (!currentPattern) return;

    // Load notes from API
    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/notes`);
        if (response.ok) {
            const data = await response.json();
            currentNotes = data.notes || '';
            editor.value = currentNotes;
        }
    } catch (error) {
        console.error('Error loading notes:', error);
        editor.value = '';
    }

    // Apply live preview state
    const livePreviewEnabled = localStorage.getItem('notesLivePreview') === 'true';
    const body = document.querySelector('.notes-popover-body');
    const tabs = document.querySelector('.notes-tabs');

    if (livePreviewEnabled) {
        body.classList.add('live-preview');
        tabs.style.display = 'none';
        updateLivePreview();
    } else {
        body.classList.remove('live-preview');
        tabs.style.display = 'flex';
        switchNotesTab('edit');
    }

    // Restore saved size
    let noteWidth = 650, noteHeight = 500;
    const savedSize = localStorage.getItem('notesPopoverSize');
    if (savedSize) {
        try {
            const parsed = JSON.parse(savedSize);
            noteWidth = parsed.width;
            noteHeight = parsed.height;
        } catch (e) { /* use defaults */ }
    }
    popover.style.cssText = `display: flex; width: ${noteWidth}px; height: ${noteHeight}px;`;
}

function closeNotesPopover() {
    const popover = document.getElementById('notes-popover');

    // Save current size to localStorage
    const rect = popover.getBoundingClientRect();
    localStorage.setItem('notesPopoverSize', JSON.stringify({
        width: rect.width,
        height: rect.height
    }));

    popover.style.display = 'none';
}

// Close notes popover when clicking outside
document.addEventListener('click', (e) => {
    const popover = document.getElementById('notes-popover');
    if (popover && popover.style.display !== 'none') {
        // Check if click is outside the popover and not on the notes button
        const notesBtn = document.getElementById('notes-btn');
        if (!popover.contains(e.target) && e.target !== notesBtn && !notesBtn?.contains(e.target)) {
            closeNotesPopover();
        }
    }
});

// Close notes popover and mobile menu when clicking into PDF iframe (window loses focus to iframe)
window.addEventListener('blur', () => {
    setTimeout(() => {
        if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
            const popover = document.getElementById('notes-popover');
            if (popover && popover.style.display !== 'none') {
                closeNotesPopover();
            }
            const mobileMenu = document.getElementById('mobile-menu');
            if (mobileMenu) mobileMenu.style.display = 'none';
        }
    }, 0);
});


function initNotesDrag() {
    const popover = document.getElementById('notes-popover');
    const header = document.querySelector('.notes-popover-header');

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        // Don't drag if clicking on buttons or tabs
        if (e.target.tagName === 'BUTTON') return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // Get current position
        const rect = popover.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        // Change cursor
        header.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        // Calculate new position
        let newLeft = initialLeft + deltaX;
        let newTop = initialTop + deltaY;

        // Keep within viewport bounds
        const popoverRect = popover.getBoundingClientRect();
        const maxLeft = window.innerWidth - popoverRect.width;
        const maxTop = window.innerHeight - popoverRect.height;

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        popover.style.left = newLeft + 'px';
        popover.style.top = newTop + 'px';
        popover.style.right = 'auto';
        popover.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'grab';
        }
    });
}

function switchNotesTab(tab) {
    const editTab = document.querySelector('.notes-tab[data-tab="edit"]');
    const previewTab = document.querySelector('.notes-tab[data-tab="preview"]');
    const editor = document.getElementById('notes-editor');
    const preview = document.getElementById('notes-preview');

    if (tab === 'edit') {
        editTab.classList.add('active');
        previewTab.classList.remove('active');
        editor.style.display = 'block';
        preview.style.display = 'none';
    } else {
        editTab.classList.remove('active');
        previewTab.classList.add('active');
        editor.style.display = 'none';
        preview.style.display = 'block';
        preview.innerHTML = renderMarkdown(editor.value);
    }
}

async function saveNotes(showStatus = false) {
    if (!currentPattern) return;

    const editor = document.getElementById('notes-editor');
    const notes = editor.value;
    const statusEl = document.getElementById('notes-save-status');

    try {
        if (showStatus && statusEl) {
            statusEl.textContent = 'Saving...';
            statusEl.className = 'notes-save-status saving';
        }

        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });

        if (response.ok) {
            currentNotes = notes;
            if (showStatus && statusEl) {
                statusEl.textContent = 'Saved';
                statusEl.className = 'notes-save-status saved';
                setTimeout(() => {
                    statusEl.textContent = '';
                    statusEl.className = 'notes-save-status';
                }, 2000);
            }
        }
    } catch (error) {
        console.error('Error saving notes:', error);
        if (showStatus && statusEl) {
            statusEl.textContent = 'Failed to save';
            statusEl.className = 'notes-save-status error';
        }
    }
}

function scheduleNotesAutoSave() {
    if (notesAutoSaveTimeout) {
        clearTimeout(notesAutoSaveTimeout);
    }
    notesAutoSaveTimeout = setTimeout(() => {
        saveNotes(true);
    }, 1000); // Save after 1 second of inactivity

    // Update live preview if enabled
    updateLivePreview();
}

let notesScrollSyncCleanup = null;

function toggleLivePreview() {
    const checkbox = document.getElementById('notes-live-preview');
    const body = document.querySelector('.notes-popover-body');
    const tabs = document.querySelector('.notes-tabs');

    localStorage.setItem('notesLivePreview', checkbox.checked);

    // Clean up previous scroll sync
    if (notesScrollSyncCleanup) {
        notesScrollSyncCleanup();
        notesScrollSyncCleanup = null;
    }

    if (checkbox.checked) {
        body.classList.add('live-preview');
        tabs.style.display = 'none';
        updateLivePreview();
        // Set up scroll sync
        const editor = document.getElementById('notes-editor');
        const preview = document.getElementById('notes-preview');
        if (editor && preview) {
            notesScrollSyncCleanup = setupScrollSync(editor, preview);
        }
    } else {
        body.classList.remove('live-preview');
        tabs.style.display = 'flex';
        // Reset to edit tab when turning off live preview
        switchNotesTab('edit');
    }
}

function updateLivePreview() {
    const checkbox = document.getElementById('notes-live-preview');
    if (!checkbox.checked) return;

    const editor = document.getElementById('notes-editor');
    const preview = document.getElementById('notes-preview');
    preview.innerHTML = renderMarkdown(editor.value);
    // Auto-scroll preview to bottom when editor is near the bottom
    const editorNearBottom = editor.scrollHeight - editor.scrollTop - editor.clientHeight < 50;
    if (editorNearBottom) {
        preview.scrollTop = preview.scrollHeight;
    }
}

function clearNotes() {
    const clearBtn = document.getElementById('notes-clear-btn');

    if (!clearConfirmPending) {
        // First click - show confirmation
        clearConfirmPending = true;
        clearBtn.textContent = 'Confirm Clear';
        clearBtn.classList.add('confirm');

        // Reset after 3 seconds if not confirmed
        setTimeout(() => {
            if (clearConfirmPending) {
                clearConfirmPending = false;
                clearBtn.textContent = 'Clear';
                clearBtn.classList.remove('confirm');
            }
        }, 3000);
    } else {
        // Second click - clear the notes
        const editor = document.getElementById('notes-editor');
        editor.value = '';
        clearConfirmPending = false;
        clearBtn.textContent = 'Clear';
        clearBtn.classList.remove('confirm');

        // Trigger auto-save
        scheduleNotesAutoSave();
    }
}

// Markdown renderer using marked library
function renderMarkdown(text) {
    if (!text) return '<p class="notes-empty">No notes yet.</p>';

    // Configure marked for safe rendering
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            breaks: true, // Convert \n to <br>
            gfm: true,    // GitHub Flavored Markdown
        });
        return marked.parse(text);
    }

    // Fallback if marked not loaded
    return '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';
}

// Scroll sync between editor textarea and preview pane
function setupScrollSync(editorEl, previewEl) {
    let syncing = false;

    function syncScroll(source, target) {
        if (syncing) return;
        syncing = true;
        const maxScroll = source.scrollHeight - source.clientHeight;
        const ratio = maxScroll > 0 ? source.scrollTop / maxScroll : 0;
        const targetMax = target.scrollHeight - target.clientHeight;
        target.scrollTop = ratio * targetMax;
        // Reset flag after browser paints the scroll
        requestAnimationFrame(() => { syncing = false; });
    }

    function onEditorScroll() { syncScroll(editorEl, previewEl); }
    function onPreviewScroll() { syncScroll(previewEl, editorEl); }

    editorEl.addEventListener('scroll', onEditorScroll);
    previewEl.addEventListener('scroll', onPreviewScroll);

    // Return cleanup function
    return function cleanup() {
        editorEl.removeEventListener('scroll', onEditorScroll);
        previewEl.removeEventListener('scroll', onPreviewScroll);
    };
}

// Edit modal functionality
function initEditModal() {
    const modal = document.getElementById('edit-modal');
    const closeBtn = document.getElementById('close-edit-modal');
    const cancelBtn = document.getElementById('cancel-edit-btn');
    const deleteBtn = document.getElementById('delete-edit-pattern');
    const editForm = document.getElementById('edit-form');

    if (closeBtn) closeBtn.addEventListener('click', closeEditModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditModal);
    if (deleteBtn) deleteBtn.addEventListener('click', deleteEditPattern);
    const dupBtn = document.getElementById('duplicate-edit-pattern');
    if (dupBtn) dupBtn.addEventListener('click', () => { const id = parseInt(editingPatternId); if (id) { closeEditModal(); duplicatePattern(id); } });
    const copyEditBtn = document.getElementById('copy-to-account-edit-btn');
    if (copyEditBtn) copyEditBtn.addEventListener('click', () => { const id = parseInt(editingPatternId); if (id) { closeEditModal(); copyPatternToAccount(id); } });

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeEditModal();
            }
        });
    }

    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await savePatternEdits();
        });
    }
}

function deleteEditPattern() {
    if (!editingPatternId) return;
    closeEditModal();
    deletePattern(editingPatternId);
}

async function openEditModal(patternId) {
    editingPatternId = patternId;
    const pattern = patterns.find(p => p.id == patternId);

    if (!pattern) {
        console.error('Pattern not found');
        return;
    }

    document.getElementById('edit-pattern-name').value = pattern.name;

    // Create category dropdown
    const categoryContainer = document.getElementById('edit-pattern-category-container');
    categoryContainer.innerHTML = createCategoryDropdown('edit-category', pattern.category || getDefaultCategory());

    const descValue = pattern.description || '';
    document.getElementById('edit-pattern-description').value = descValue;
    document.getElementById('edit-desc-count').textContent = descValue.length;

    // Create hashtag selector with current pattern's hashtags
    const hashtagContainer = document.getElementById('edit-pattern-hashtags-container');
    const selectedHashtagIds = (pattern.hashtags || []).map(h => h.id);
    hashtagContainer.innerHTML = createHashtagSelector('edit-hashtags', selectedHashtagIds);

    // Set existing thumbnail in selector
    if (pattern.thumbnail) {
        setThumbnailSelectorImage('edit', `${API_URL}${pattern.thumbnail}`);
    } else {
        clearThumbnailSelector('edit');
    }

    // Populate inventory tab selectors
    const yarnContainer = document.getElementById('edit-pattern-yarns-container');
    const hookContainer = document.getElementById('edit-pattern-hooks-container');
    try {
        const [yarnRes, hookRes] = await Promise.all([
            fetch(`${API_URL}/api/patterns/${patternId}/yarns`),
            fetch(`${API_URL}/api/patterns/${patternId}/hooks`)
        ]);
        const linkedYarns = yarnRes.ok ? await yarnRes.json() : [];
        const linkedHooks = hookRes.ok ? await hookRes.json() : [];
        yarnContainer.innerHTML = createYarnSelector(linkedYarns.map(y => y.id));
        hookContainer.innerHTML = createHookSelector(linkedHooks.map(h => h.id));
    } catch (e) {
        yarnContainer.innerHTML = createYarnSelector([]);
        hookContainer.innerHTML = createHookSelector([]);
    }
    updateInventoryTabBadge('edit');

    // Set current toggle state
    document.getElementById('edit-is-current').checked = pattern.is_current || false;

    // Rating
    document.getElementById('edit-pattern-rating').innerHTML = ratingInputHtml('edit-pattern-rating-input', pattern.rating || 0);

    // Swap Duplicate for Copy to My Account when viewing someone else's pattern
    const editPatternOwner = pattern.owner_username || null;
    const isEditOwnPattern = !editPatternOwner
        || editPatternOwner === currentUser?.username
        || String(pattern.user_id) === String(currentUser?.id)
        || pattern.user_id == null;
    const dupBtn2 = document.getElementById('duplicate-edit-pattern');
    const copyToAccountEditBtn = document.getElementById('copy-to-account-edit-btn');
    if (dupBtn2) dupBtn2.style.display = isEditOwnPattern ? '' : 'none';
    if (copyToAccountEditBtn) copyToAccountEditBtn.style.display = isEditOwnPattern ? 'none' : '';

    resetEditModalTab('edit');
    document.getElementById('edit-modal').style.display = 'flex';
}

function closeEditModal() {
    document.getElementById('edit-modal').style.display = 'none';
    editingPatternId = null;
}

async function savePatternEdits() {
    if (!editingPatternId) return;

    const name = document.getElementById('edit-pattern-name').value;
    const category = getCategoryDropdownValue('edit-category');
    const description = document.getElementById('edit-pattern-description').value;
    const thumbnailFile = getThumbnailFile('edit');
    const hashtagIds = getSelectedHashtagIds('edit-hashtags');
    const isCurrent = document.getElementById('edit-is-current').checked;

    // Get current pattern to check if is_current changed
    const pattern = patterns.find(p => p.id == editingPatternId);

    try {
        // Update pattern details
        const rating = parseInt(document.getElementById('edit-pattern-rating-input')?.dataset.rating) || 0;
        const response = await fetch(`${API_URL}/api/patterns/${editingPatternId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, description, rating })
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('Error updating pattern:', error.error);
            return;
        }

        // Update current status if changed
        if (pattern && isCurrent !== pattern.is_current) {
            await fetch(`${API_URL}/api/patterns/${editingPatternId}/current`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isCurrent })
            });
        }

        // Update hashtags
        await fetch(`${API_URL}/api/patterns/${editingPatternId}/hashtags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashtagIds })
        });

        // Update linked yarns and hooks
        const yarnIds = getSelectedYarnIds();
        const hookIds = getSelectedHookIds();
        await Promise.all([
            fetch(`${API_URL}/api/patterns/${editingPatternId}/yarns`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ yarnIds })
            }),
            fetch(`${API_URL}/api/patterns/${editingPatternId}/hooks`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hookIds })
            })
        ]);

        // If custom thumbnail was uploaded, handle it separately
        if (thumbnailFile) {
            console.log('Uploading thumbnail:', thumbnailFile.name, thumbnailFile.size, 'bytes');
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            const thumbResponse = await fetch(`${API_URL}/api/patterns/${editingPatternId}/thumbnail`, {
                method: 'POST',
                body: formData
            });
            if (!thumbResponse.ok) {
                console.error('Thumbnail upload failed:', await thumbResponse.text());
            } else {
                console.log('Thumbnail uploaded successfully');
            }
        } else {
            console.log('No thumbnail file to upload');
        }

        closeEditModal();
        await loadPatterns();
        await loadCurrentPatterns();
        await loadCategories();
    } catch (error) {
        console.error('Error updating pattern:', error);
    }
}

// Markdown Viewer Functions
const markdownViewerContainer = document.getElementById('markdown-viewer-container');
let markdownNotesAutoSaveTimeout = null;
let markdownInlineEditing = false;
let markdownInlineEditorDirty = false;
let markdownInlineAutoSaveTimeout = null;
let markdownRawContent = '';

async function openMarkdownViewer(pattern, pushHistory = true) {
    try {
        currentPattern = pattern;

        // Push to navigation history
        if (pushHistory && !isNavigatingBack) {
            const currentView = getCurrentView();
            if (currentView && !currentView.startsWith('pattern/')) {
                navigationHistory.push(currentView);
            }
            const slug = getPatternSlug(pattern);
            history.pushState({ view: `pattern/${slug}` }, '', `#pattern/${slug}`);
        }

        // Store pattern ID on container for getCurrentView
        markdownViewerContainer.dataset.patternId = pattern.id;

        // Load timer state
        loadPatternTimer(pattern);

        // Initialize auto timer: restore per-pattern session state, else use default
        const savedAutoTimer = sessionStorage.getItem(`autoTimer_${pattern.id}`);
        autoTimerEnabled = savedAutoTimer !== null ? savedAutoTimer === 'true' : autoTimerDefault;
        autoTimerPausedInactive = false;
        updateAutoTimerButtonState();
        if (autoTimerEnabled) {
            // Start timer and inactivity tracking
            startTimer();
            if (inactivityTimeout) clearTimeout(inactivityTimeout);
            if (inactivityDelay > 0) {
                inactivityTimeout = setTimeout(() => {
                    if (autoTimerEnabled && timerRunning) {
                        autoTimerPausedInactive = true;
                        stopTimer();
                        updateAutoTimerButtonState();
                    }
                }, inactivityDelay);
            }
        }

        // Clear old counters and move overlay before showing viewer
        document.getElementById('counters-list').innerHTML = '';
        const counterOverlay = document.getElementById('shared-counter-overlay');
        markdownViewerContainer.appendChild(counterOverlay);

        // Hide tabs and show markdown viewer
        document.querySelector('.tabs').style.display = 'none';
        tabContents.forEach(c => c.style.display = 'none');
        markdownViewerContainer.style.display = 'flex';
        requestWakeLock();

        // Update header
        document.getElementById('markdown-pattern-name').textContent = pattern.name;
        const mdMobileName = document.getElementById('md-mobile-pattern-name');
        if (mdMobileName) mdMobileName.textContent = pattern.name;

        // Load markdown content and counters in parallel
        const [contentResponse] = await Promise.all([
            fetch(`${API_URL}/api/patterns/${pattern.id}/content`),
            loadCounters(pattern.id)
        ]);

        if (contentResponse.ok) {
            const data = await contentResponse.json();
            const markdownContent = document.getElementById('markdown-content');
            markdownContent.innerHTML = renderMarkdown(data.content || '');
            // Store raw content for inline editing
            markdownRawContent = data.content || '';
            document.getElementById('markdown-inline-editor').value = markdownRawContent;
        }

        // Reset to preview mode
        resetInlineEditMode();

        // Initialize markdown viewer events
        initMarkdownViewerEvents();

    } catch (error) {
        console.error('Error opening markdown viewer:', error);
    }
}

function initMarkdownViewerEvents() {
    // Back button
    const backBtn = document.getElementById('markdown-back-btn');
    backBtn.onclick = closeMarkdownViewer;

    // Notes button
    const notesBtn = document.getElementById('markdown-notes-btn');
    notesBtn.onclick = toggleMarkdownNotes;

    // Inline edit toggle button
    const editToggleBtn = document.getElementById('markdown-edit-toggle-btn');
    editToggleBtn.onclick = toggleInlineEditMode;

    // Details button (metadata modal)
    const editBtn = document.getElementById('markdown-edit-btn');
    editBtn.onclick = openMarkdownEditModal;

    // Info button
    const infoBtn = document.getElementById('markdown-info-btn');
    if (infoBtn) {
        infoBtn.onclick = openPatternInfoModal;
    }

    // Notes close button
    const notesCloseBtn = document.getElementById('markdown-notes-close-btn');
    notesCloseBtn.onclick = closeMarkdownNotes;

    // Notes clear button
    const notesClearBtn = document.getElementById('markdown-notes-clear-btn');
    notesClearBtn.onclick = clearMarkdownNotes;

    // Notes tabs
    const notesTabs = document.querySelectorAll('#markdown-notes-popover .notes-tab');
    notesTabs.forEach(tab => {
        tab.onclick = () => switchMarkdownNotesTab(tab.dataset.tab);
    });

    // Notes live preview checkbox
    const livePreviewCheckbox = document.getElementById('markdown-notes-live-preview');
    livePreviewCheckbox.onchange = () => {
        toggleMarkdownNotesLivePreview(livePreviewCheckbox.checked);
    };

    // Notes editor auto-save
    const notesEditor = document.getElementById('markdown-notes-editor');
    notesEditor.oninput = handleMarkdownNotesInput;
    // Enable auto-continue for lists and image paste
    setupMarkdownListContinuation(notesEditor);
    setupImagePaste(notesEditor, () => currentPattern?.name || 'pattern');

    // Inline editor input handler
    const inlineEditor = document.getElementById('markdown-inline-editor');
    inlineEditor.oninput = handleInlineEditorInput;
    // Setup list continuation and image paste (once, guarded)
    if (!inlineEditor.dataset.setupDone) {
        setupMarkdownListContinuation(inlineEditor);
        setupImagePaste(inlineEditor, () => currentPattern?.name || 'pattern');
        // Ctrl+S / Cmd+S to force-save
        inlineEditor.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (markdownInlineAutoSaveTimeout) clearTimeout(markdownInlineAutoSaveTimeout);
                saveInlineContent();
            }
        });
        inlineEditor.dataset.setupDone = 'true';
    }

    // Inline live preview toggle
    const inlineLivePreview = document.getElementById('inline-live-preview');
    if (inlineLivePreview) {
        inlineLivePreview.onchange = () => {
            toggleInlineLivePreview(inlineLivePreview.checked);
        };
    }

    // Inline edit Done button (mobile)
    const inlineDoneBtn = document.getElementById('markdown-inline-done-btn');
    if (inlineDoneBtn) inlineDoneBtn.onclick = toggleInlineEditMode;

    // Details modal events
    const closeEditModalBtn = document.getElementById('close-markdown-edit-modal');
    closeEditModalBtn.onclick = closeMarkdownEditModal;

    const cancelEditBtn = document.getElementById('cancel-markdown-edit');
    cancelEditBtn.onclick = closeMarkdownEditModal;

    const saveEditBtn = document.getElementById('save-markdown-edit');
    saveEditBtn.onclick = saveMarkdownEdit;

    const deleteMarkdownBtn = document.getElementById('delete-markdown-pattern');
    deleteMarkdownBtn.onclick = deleteMarkdownPattern;

    const dupMarkdownBtn = document.getElementById('duplicate-markdown-pattern');
    if (dupMarkdownBtn) dupMarkdownBtn.onclick = () => { if (currentPattern) { closeMarkdownEditModal(); duplicatePattern(currentPattern.id); } };

    const copyMdBtn = document.getElementById('copy-to-account-markdown-btn');
    if (copyMdBtn) copyMdBtn.addEventListener('click', () => { const id = parseInt(currentPattern?.id); if (id) { closeMarkdownEditModal(); copyPatternToAccount(id); } });

    const editModal = document.getElementById('markdown-edit-modal');
    editModal.onclick = (e) => {
        if (e.target === editModal) closeMarkdownEditModal();
    };

    // --- Mobile top bar for markdown viewer ---
    const mdMobileBackBtn = document.getElementById('md-mobile-back-btn');
    if (mdMobileBackBtn) mdMobileBackBtn.onclick = closeMarkdownViewer;

    const mdMobileTimerBtn = document.getElementById('md-mobile-timer-btn');
    if (mdMobileTimerBtn) mdMobileTimerBtn.onclick = toggleTimer;

    const mdMobileMenuBtn = document.getElementById('md-mobile-menu-btn');
    const mdMobileMenu = document.getElementById('md-mobile-menu');
    if (mdMobileMenuBtn && mdMobileMenu) {
        mdMobileMenuBtn.onclick = (e) => {
            e.stopPropagation();
            mdMobileMenu.style.display = mdMobileMenu.style.display === 'none' ? 'block' : 'none';
        };
        document.addEventListener('click', (e) => {
            if (!mdMobileMenuBtn.contains(e.target) && !mdMobileMenu.contains(e.target)) {
                mdMobileMenu.style.display = 'none';
            }
        });
    }

    const mdMobileNotesBtn = document.getElementById('md-mobile-notes-btn');
    if (mdMobileNotesBtn) mdMobileNotesBtn.onclick = () => {
        mdMobileMenu.style.display = 'none';
        toggleMarkdownNotes();
    };

    const mdMobileEditBtn = document.getElementById('md-mobile-edit-btn');
    if (mdMobileEditBtn) mdMobileEditBtn.onclick = () => {
        mdMobileMenu.style.display = 'none';
        toggleInlineEditMode();
    };

    const mdMobileDetailsBtn = document.getElementById('md-mobile-details-btn');
    if (mdMobileDetailsBtn) mdMobileDetailsBtn.onclick = () => {
        mdMobileMenu.style.display = 'none';
        openMarkdownEditModal();
    };

    const mdMobileAutoTimerCheckbox = document.getElementById('md-mobile-auto-timer-checkbox');
    if (mdMobileAutoTimerCheckbox) mdMobileAutoTimerCheckbox.onchange = toggleAutoTimer;

    const mdMobileTimerResetBtn = document.getElementById('md-mobile-timer-reset-btn');
    if (mdMobileTimerResetBtn) mdMobileTimerResetBtn.onclick = () => {
        if (timerResetConfirming) {
            mdMobileMenu.style.display = 'none';
        }
        handleTimerReset();
    };
}

// Inline content editing
function toggleInlineEditMode() {
    if (markdownInlineEditing) {
        exitInlineEditMode();
    } else {
        enterInlineEditMode();
    }
}

async function enterInlineEditMode() {
    markdownInlineEditing = true;
    const contentEl = document.getElementById('markdown-content');
    const editorEl = document.getElementById('markdown-inline-editor');
    const saveBar = document.getElementById('markdown-inline-save-bar');
    const toggleBtn = document.getElementById('markdown-edit-toggle-btn');
    const wrapper = document.querySelector('.markdown-viewer-wrapper');

    // Fetch content directly from API to guarantee fresh data
    if (currentPattern) {
        try {
            const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/content`);
            if (response.ok) {
                const data = await response.json();
                markdownRawContent = data.content || '';
            }
        } catch (e) {
            console.error('Error loading content for editor:', e);
        }
    }
    editorEl.value = markdownRawContent;

    // Show editor, hide rendered content
    contentEl.style.display = 'none';
    editorEl.style.display = 'block';
    wrapper.classList.add('editing');

    // Update toggle button
    toggleBtn.classList.add('active');
    toggleBtn.querySelector('span').textContent = 'Done';

    editorEl.focus();
    markdownInlineEditorDirty = false;
}

function exitInlineEditMode() {
    if (!markdownInlineEditing) return;
    markdownInlineEditing = false;

    const contentEl = document.getElementById('markdown-content');
    const editorEl = document.getElementById('markdown-inline-editor');
    const saveBar = document.getElementById('markdown-inline-save-bar');
    const toggleBtn = document.getElementById('markdown-edit-toggle-btn');
    const wrapper = document.querySelector('.markdown-viewer-wrapper');

    // Save if dirty
    if (markdownInlineEditorDirty) {
        saveInlineContent();
    }

    // Clear pending auto-save
    if (markdownInlineAutoSaveTimeout) {
        clearTimeout(markdownInlineAutoSaveTimeout);
        markdownInlineAutoSaveTimeout = null;
    }

    // Re-render preview from textarea
    const content = editorEl.value;
    contentEl.innerHTML = renderMarkdown(content);
    markdownRawContent = content;

    // Clean up inline live preview
    if (inlineScrollSyncCleanup) {
        inlineScrollSyncCleanup();
        inlineScrollSyncCleanup = null;
    }
    wrapper.classList.remove('inline-live-preview');
    const inlineLivePreview = document.getElementById('inline-live-preview');
    if (inlineLivePreview) inlineLivePreview.checked = false;

    // Show rendered content, hide editor
    contentEl.style.display = 'block';
    editorEl.style.display = 'none';
    wrapper.classList.remove('editing');

    // Update toggle button
    toggleBtn.classList.remove('active');
    toggleBtn.querySelector('span').textContent = 'Edit';
}

function resetInlineEditMode() {
    markdownInlineEditing = false;
    markdownInlineEditorDirty = false;
    if (markdownInlineAutoSaveTimeout) {
        clearTimeout(markdownInlineAutoSaveTimeout);
        markdownInlineAutoSaveTimeout = null;
    }
    const contentEl = document.getElementById('markdown-content');
    const editorEl = document.getElementById('markdown-inline-editor');
    const saveBar = document.getElementById('markdown-inline-save-bar');
    const toggleBtn = document.getElementById('markdown-edit-toggle-btn');
    const wrapper = document.querySelector('.markdown-viewer-wrapper');

    // Clean up inline live preview
    if (inlineScrollSyncCleanup) {
        inlineScrollSyncCleanup();
        inlineScrollSyncCleanup = null;
    }
    wrapper.classList.remove('inline-live-preview');
    const inlineLivePreview = document.getElementById('inline-live-preview');
    if (inlineLivePreview) inlineLivePreview.checked = false;

    contentEl.style.display = 'block';
    editorEl.style.display = 'none';
    wrapper.classList.remove('editing');
    if (toggleBtn) {
        toggleBtn.classList.remove('active');
        toggleBtn.querySelector('span').textContent = 'Edit';
    }
}

let inlineScrollSyncCleanup = null;

function toggleInlineLivePreview(enabled) {
    const wrapper = document.querySelector('.markdown-viewer-wrapper');
    const contentEl = document.getElementById('markdown-content');
    const editorEl = document.getElementById('markdown-inline-editor');

    // Clean up previous scroll sync
    if (inlineScrollSyncCleanup) {
        inlineScrollSyncCleanup();
        inlineScrollSyncCleanup = null;
    }

    if (enabled) {
        wrapper.classList.add('inline-live-preview');
        contentEl.style.display = 'block';
        contentEl.innerHTML = renderMarkdown(editorEl.value);
        inlineScrollSyncCleanup = setupScrollSync(editorEl, contentEl);
    } else {
        wrapper.classList.remove('inline-live-preview');
        contentEl.style.display = 'none';
    }
}

function handleInlineEditorInput() {
    markdownInlineEditorDirty = true;
    // Update live preview if enabled
    const livePreview = document.getElementById('inline-live-preview');
    if (livePreview && livePreview.checked) {
        const editorEl = document.getElementById('markdown-inline-editor');
        const contentEl = document.getElementById('markdown-content');
        contentEl.innerHTML = renderMarkdown(editorEl.value);
        // Auto-scroll preview to bottom when editor is near the bottom
        const editorNearBottom = editorEl.scrollHeight - editorEl.scrollTop - editorEl.clientHeight < 50;
        if (editorNearBottom) {
            contentEl.scrollTop = contentEl.scrollHeight;
        }
    }
    scheduleInlineAutoSave();
}

function scheduleInlineAutoSave() {
    if (markdownInlineAutoSaveTimeout) {
        clearTimeout(markdownInlineAutoSaveTimeout);
    }
    const statusEl = document.getElementById('markdown-inline-save-status');
    statusEl.textContent = '';

    markdownInlineAutoSaveTimeout = setTimeout(async () => {
        await saveInlineContent();
    }, 1500);
}

async function saveInlineContent() {
    if (!currentPattern) return;
    const content = document.getElementById('markdown-inline-editor').value;
    const statusEl = document.getElementById('markdown-inline-save-status');

    try {
        statusEl.textContent = 'Saving...';
        statusEl.className = 'notes-save-status saving';
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });

        if (response.ok) {
            markdownInlineEditorDirty = false;
            markdownRawContent = content;
            statusEl.textContent = 'Saved';
            statusEl.className = 'notes-save-status saved';
            setTimeout(() => { if (statusEl.textContent === 'Saved') { statusEl.textContent = ''; statusEl.className = 'notes-save-status'; } }, 2000);
        } else {
            statusEl.textContent = 'Error saving';
            statusEl.className = 'notes-save-status error';
        }
    } catch (error) {
        console.error('Error saving inline content:', error);
        statusEl.textContent = 'Error saving';
        statusEl.className = 'notes-save-status error';
    }
}

async function closeMarkdownViewer() {
    // Save pending inline edits
    if (markdownInlineEditing && markdownInlineEditorDirty) {
        await saveInlineContent();
    }
    resetInlineEditMode();
    releaseWakeLock();
    // Stash timer in sessionStorage so reopening doesn't lose seconds to server lag
    if (currentPattern && timerSeconds > 0) {
        sessionStorage.setItem(`timerSeconds_${currentPattern.id}`, timerSeconds);
    }
    // Save timer before closing (immediate, not debounced)
    if (currentPattern && timerSeconds > 0) {
        if (timerRunning) {
            timerRunning = false;
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
        }
        await saveTimerImmediate();
    }

    // Clear viewing pattern from sessionStorage

    // Reset state
    resetTimerState();
    currentPattern = null;
    lastUsedCounterId = null;

    // Reload patterns for when we return to list view
    await loadCurrentPatterns();
    await loadPatterns();

    // Navigate back using history (this will hide the viewer and show tabs)
    await navigateBack();
}

// Markdown notes functionality
async function toggleMarkdownNotes() {
    const popover = document.getElementById('markdown-notes-popover');
    const isVisible = popover.style.display !== 'none';

    if (isVisible) {
        closeMarkdownNotes();
    } else {
        // Load notes from pattern
        const notesEditor = document.getElementById('markdown-notes-editor');
        notesEditor.value = currentPattern.notes || '';

        // Reset to edit tab
        switchMarkdownNotesTab('edit');

        popover.style.display = 'flex';
    }
}

function closeMarkdownNotes() {
    document.getElementById('markdown-notes-popover').style.display = 'none';
}

// Close markdown notes popover when clicking outside
document.addEventListener('click', (e) => {
    const popover = document.getElementById('markdown-notes-popover');
    if (popover && popover.style.display !== 'none') {
        const notesBtn = document.getElementById('markdown-notes-btn');
        if (!popover.contains(e.target) && e.target !== notesBtn && !notesBtn?.contains(e.target)) {
            closeMarkdownNotes();
        }
    }
});

let markdownNotesScrollSyncCleanup = null;

function toggleMarkdownNotesLivePreview(enabled) {
    const body = document.querySelector('#markdown-notes-popover .notes-popover-body');
    const tabs = document.querySelector('#markdown-notes-popover .notes-tabs');
    const editor = document.getElementById('markdown-notes-editor');
    const preview = document.getElementById('markdown-notes-preview');

    // Clean up previous scroll sync
    if (markdownNotesScrollSyncCleanup) {
        markdownNotesScrollSyncCleanup();
        markdownNotesScrollSyncCleanup = null;
    }

    if (enabled) {
        body.classList.add('live-preview');
        tabs.style.display = 'none';
        editor.style.display = 'block';
        preview.style.display = 'block';
        preview.innerHTML = renderMarkdown(editor.value);
        // Set up scroll sync
        if (editor && preview) {
            markdownNotesScrollSyncCleanup = setupScrollSync(editor, preview);
        }
    } else {
        body.classList.remove('live-preview');
        tabs.style.display = 'flex';
        // Reset to edit tab
        switchMarkdownNotesTab('edit');
    }
}

function switchMarkdownNotesTab(tab) {
    const tabs = document.querySelectorAll('#markdown-notes-popover .notes-tab');
    const editor = document.getElementById('markdown-notes-editor');
    const preview = document.getElementById('markdown-notes-preview');

    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

    if (tab === 'edit') {
        editor.style.display = 'block';
        preview.style.display = 'none';
    } else {
        editor.style.display = 'none';
        preview.style.display = 'block';
        preview.innerHTML = renderMarkdown(editor.value);
    }
}

function handleMarkdownNotesInput() {
    const livePreview = document.getElementById('markdown-notes-live-preview').checked;
    if (livePreview) {
        const editor = document.getElementById('markdown-notes-editor');
        const preview = document.getElementById('markdown-notes-preview');
        preview.innerHTML = renderMarkdown(editor.value);
        // Auto-scroll preview to bottom when editor is near the bottom
        const editorNearBottom = editor.scrollHeight - editor.scrollTop - editor.clientHeight < 50;
        if (editorNearBottom) {
            preview.scrollTop = preview.scrollHeight;
        }
    }
    scheduleMarkdownNotesAutoSave();
}

function scheduleMarkdownNotesAutoSave() {
    if (markdownNotesAutoSaveTimeout) {
        clearTimeout(markdownNotesAutoSaveTimeout);
    }
    const statusEl = document.getElementById('markdown-notes-save-status');
    statusEl.textContent = 'Saving...';

    markdownNotesAutoSaveTimeout = setTimeout(async () => {
        await saveMarkdownNotes();
    }, 1000);
}

async function saveMarkdownNotes() {
    if (!currentPattern) return;

    const notes = document.getElementById('markdown-notes-editor').value;
    const statusEl = document.getElementById('markdown-notes-save-status');

    try {
        await fetch(`${API_URL}/api/patterns/${currentPattern.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });
        currentPattern.notes = notes;
        statusEl.textContent = 'Saved';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } catch (error) {
        console.error('Error saving notes:', error);
        statusEl.textContent = 'Error saving';
    }
}

async function clearMarkdownNotes() {
    if (!confirm('Clear all notes?')) return;
    document.getElementById('markdown-notes-editor').value = '';
    await saveMarkdownNotes();
    switchMarkdownNotesTab('edit');
}

// Markdown details modal (metadata only)
async function openMarkdownEditModal() {
    const modal = document.getElementById('markdown-edit-modal');

    // Populate metadata fields
    document.getElementById('markdown-edit-name').value = currentPattern.name || '';
    document.getElementById('markdown-edit-description').value = currentPattern.description || '';

    // Populate category dropdown
    const categoryContainer = document.getElementById('markdown-edit-category-container');
    categoryContainer.innerHTML = createCategoryDropdown('markdown-edit-category', currentPattern.category || getDefaultCategory());

    // Populate hashtags selector
    const hashtagsContainer = document.getElementById('markdown-edit-hashtags-container');
    const patternHashtagIds = (currentPattern.hashtags || []).map(h => h.id);
    hashtagsContainer.innerHTML = createHashtagSelector('markdown-edit-hashtags', patternHashtagIds);

    // Populate inventory tab selectors
    const mdYarnContainer = document.getElementById('markdown-edit-yarns-container');
    const mdHookContainer = document.getElementById('markdown-edit-hooks-container');
    try {
        const [yarnRes, hookRes] = await Promise.all([
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/yarns`),
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/hooks`)
        ]);
        const linkedYarns = yarnRes.ok ? await yarnRes.json() : [];
        const linkedHooks = hookRes.ok ? await hookRes.json() : [];
        mdYarnContainer.innerHTML = createYarnSelector(linkedYarns.map(y => y.id));
        mdHookContainer.innerHTML = createHookSelector(linkedHooks.map(h => h.id));
    } catch (e) {
        mdYarnContainer.innerHTML = createYarnSelector([]);
        mdHookContainer.innerHTML = createHookSelector([]);
    }
    updateInventoryTabBadge('markdown-edit');

    // Set existing thumbnail in selector
    if (currentPattern.thumbnail) {
        setThumbnailSelectorImage('markdown-edit', `${API_URL}${currentPattern.thumbnail}`);
    } else {
        clearThumbnailSelector('markdown-edit');
    }

    // Populate rating
    document.getElementById('markdown-edit-pattern-rating').innerHTML = ratingInputHtml('markdown-edit-pattern-rating-input', currentPattern.rating || 0);

    // Set current toggle state
    document.getElementById('markdown-edit-is-current').checked = currentPattern.is_current || false;

    // Reset delete button state
    const deleteBtn = document.getElementById('delete-markdown-pattern');
    resetDeleteButton(deleteBtn, 'Delete Pattern');

    // Show/hide Add to Account button
    const mdOwner = currentPattern.owner_username || null;
    const isMdOwnPattern = !mdOwner
        || mdOwner === currentUser?.username
        || String(currentPattern.user_id) === String(currentUser?.id)
        || currentPattern.user_id == null;
    const copyMdBtn = document.getElementById('copy-to-account-markdown-btn');
    if (copyMdBtn) copyMdBtn.style.display = isMdOwnPattern ? 'none' : '';
    const dupMdBtn = document.getElementById('duplicate-markdown-pattern');
    if (dupMdBtn) dupMdBtn.style.display = isMdOwnPattern ? '' : 'none';

    resetEditModalTab('markdown-edit');
    modal.style.display = 'flex';
}

function closeMarkdownEditModal() {
    document.getElementById('markdown-edit-modal').style.display = 'none';
    // Reset delete button state
    const deleteBtn = document.getElementById('delete-markdown-pattern');
    resetDeleteButton(deleteBtn, 'Delete Pattern');
}

async function deleteMarkdownPattern() {
    if (!currentPattern) return;

    const btn = document.getElementById('delete-markdown-pattern');

    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.textContent = 'Confirm Delete';
        return;
    }

    // Second click - actually delete
    btn.disabled = true;
    btn.textContent = 'Deleting...';

    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            closeMarkdownEditModal();
            closeMarkdownViewer();
            await loadPatterns();
            await loadCurrentPatterns();
            await loadCategories();
        } else {
            const error = await response.json();
            console.error('Error deleting pattern:', error.error);
            resetDeleteButton(btn, 'Delete Pattern');
        }
    } catch (error) {
        console.error('Error deleting pattern:', error);
        resetDeleteButton(btn, 'Delete Pattern');
    }
}

async function saveMarkdownEdit() {
    const name = document.getElementById('markdown-edit-name').value;
    const category = getCategoryDropdownValue('markdown-edit-category');
    const description = document.getElementById('markdown-edit-description').value;
    const thumbnailFile = getThumbnailFile('markdown-edit');
    const hashtagIds = getSelectedHashtagIds('markdown-edit-hashtags');
    const isCurrent = document.getElementById('markdown-edit-is-current').checked;
    const rating = parseInt(document.getElementById('markdown-edit-pattern-rating-input')?.dataset.rating) || 0;

    if (!name.trim()) {
        alert('Pattern name is required');
        return;
    }

    try {
        // Update pattern metadata
        const metaResponse = await fetch(`${API_URL}/api/patterns/${currentPattern.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, description, rating })
        });

        // Update current status if changed
        if (isCurrent !== currentPattern.is_current) {
            await fetch(`${API_URL}/api/patterns/${currentPattern.id}/current`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isCurrent })
            });
        }

        if (!metaResponse.ok) {
            const error = await metaResponse.json();
            console.error('Error updating pattern metadata:', error.error);
            alert('Error updating pattern: ' + (error.error || 'Unknown error'));
            return;
        }

        // Update hashtags
        await fetch(`${API_URL}/api/patterns/${currentPattern.id}/hashtags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashtagIds })
        });

        // Update linked yarns
        const mdYarnIds = getSelectedYarnIds('markdown-edit-yarns-container');
        const mdHookIds = getSelectedHookIds('markdown-edit-hooks-container');
        await Promise.all([
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/yarns`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ yarnIds: mdYarnIds })
            }),
            fetch(`${API_URL}/api/patterns/${currentPattern.id}/hooks`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hookIds: mdHookIds })
            })
        ]);

        // Handle thumbnail upload if provided
        if (thumbnailFile) {
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            const thumbResponse = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/thumbnail`, {
                method: 'POST',
                body: formData
            });
            if (!thumbResponse.ok) {
                console.error('Thumbnail upload failed:', await thumbResponse.text());
            }
        }

        // Update local state
        currentPattern.name = name;
        currentPattern.category = category;
        currentPattern.description = description;
        currentPattern.is_current = isCurrent;
        if (isCurrent && !currentPattern.started_date) {
            currentPattern.started_date = new Date().toISOString();
        }
        currentPattern.rating = rating;

        // Update the viewer header
        document.getElementById('markdown-pattern-name').textContent = name;
        const mdMobileName = document.getElementById('md-mobile-pattern-name');
        if (mdMobileName) mdMobileName.textContent = name;

        closeMarkdownEditModal();

        // Reload patterns to reflect changes in the library
        await loadPatterns();
        await loadCurrentPatterns();
        await loadCategories();
    } catch (error) {
        console.error('Error saving pattern:', error);
        alert('Error saving pattern: ' + error.message);
    }
}

// ============================================
// Project Functions
// ============================================

// Load all projects
async function loadProjects() {
    try {
        const response = await fetch(`${API_URL}/api/projects`);
        if (!response.ok) throw new Error('Failed to fetch projects');
        projects = await response.json();
        displayProjects();
        updateProjectsTabVisibility();
        updateTabCounts();
    } catch (error) {
        console.error('Error loading projects:', error);
    }
}

// Load current projects
async function loadCurrentProjects() {
    try {
        const response = await fetch(`${API_URL}/api/projects/current`);
        if (!response.ok) throw new Error('Failed to fetch current projects');
        currentProjects = await response.json();
        updateTabCounts();
    } catch (error) {
        console.error('Error loading current projects:', error);
    }
}

// Update projects tab visibility based on whether projects exist
function updateProjectsTabVisibility() {
    const projectsTabBtn = document.getElementById('projects-tab-btn');
    if (projectsTabBtn) {
        const hasProjects = projects.length > 0;
        projectsTabBtn.style.display = hasProjects ? 'block' : 'none';
        // Cache for instant display on next page load
        localStorage.setItem('hasProjects', hasProjects ? 'true' : 'false');
    }
}

// Display projects in the projects tab
function displayProjects() {
    const grid = document.getElementById('projects-grid');
    if (!grid) return;

    if (projects.length === 0) {
        grid.innerHTML = '<p class="empty-state">You haven\'t created any projects yet. Projects let you group multiple patterns together for larger works!</p>';
        return;
    }

    let filtered = projects;

    // Search filter
    if (projectSearchQuery) {
        const isHashtagSearch = projectSearchQuery.startsWith('#');
        const q = projectSearchQuery.replace(/^#/, '').toLowerCase();
        filtered = filtered.filter(p => {
            if (isHashtagSearch) {
                return p.hashtags && p.hashtags.some(h => h.name.toLowerCase().includes(q));
            }
            return p.name.toLowerCase().includes(q) ||
                (p.description && p.description.toLowerCase().includes(q)) ||
                (p.hashtags && p.hashtags.some(h => h.name.toLowerCase().includes(q)));
        });
    }

    // Show filter
    if (projectShowFilter === 'favorites') {
        filtered = filtered.filter(p => p.is_favorite);
    } else if (projectShowFilter === 'current') {
        filtered = filtered.filter(p => p.is_current && !p.completed);
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
        switch (projectSort) {
            case 'date-desc': return (b.id || 0) - (a.id || 0);
            case 'date-asc': return (a.id || 0) - (b.id || 0);
            case 'opened-desc': return (new Date(b.last_opened_at || 0)) - (new Date(a.last_opened_at || 0));
            case 'opened-asc': return (new Date(a.last_opened_at || 0)) - (new Date(b.last_opened_at || 0));
            case 'name-asc': return a.name.localeCompare(b.name);
            case 'name-desc': return b.name.localeCompare(a.name);
            case 'progress-desc': {
                const pa = a.pattern_count > 0 ? a.completed_count / a.pattern_count : 0;
                const pb = b.pattern_count > 0 ? b.completed_count / b.pattern_count : 0;
                return pb - pa;
            }
            case 'progress-asc': {
                const pa = a.pattern_count > 0 ? a.completed_count / a.pattern_count : 0;
                const pb = b.pattern_count > 0 ? b.completed_count / b.pattern_count : 0;
                return pa - pb;
            }
            default: return 0;
        }
    });

    if (filtered.length === 0) {
        grid.innerHTML = '<p class="empty-state">No matching projects found.</p>';
        return;
    }

    grid.innerHTML = filtered.map(project => renderProjectCard(project)).join('');
}

// Initialize project sidebar controls
function initProjectSidebar() {
    const searchInput = document.getElementById('project-search-input');
    const searchClearBtn = document.getElementById('project-search-clear-btn');
    const mobileSearchInput = document.getElementById('project-mobile-search-input');
    const mobileSearchClearBtn = document.getElementById('project-mobile-search-clear-btn');
    const sortSelect = document.getElementById('project-sort-select');
    const showFilterSelect = document.getElementById('project-show-filter');
    const projectMobileFilterBtn = document.getElementById('project-mobile-filter-btn');

    if (sortSelect) sortSelect.value = projectSort;
    if (showFilterSelect) showFilterSelect.value = projectShowFilter;

    // Mobile filter toggle
    if (projectMobileFilterBtn) {
        projectMobileFilterBtn.addEventListener('click', () => {
            const sidebar = document.querySelector('.projects-sidebar');
            if (sidebar) {
                sidebar.classList.toggle('mobile-visible');
                projectMobileFilterBtn.classList.toggle('active', sidebar.classList.contains('mobile-visible'));
            }
        });
    }

    // Desktop search input
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            projectSearchQuery = e.target.value.toLowerCase();
            if (mobileSearchInput) mobileSearchInput.value = e.target.value;
            if (searchClearBtn) searchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            if (mobileSearchClearBtn) mobileSearchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            displayProjects();
        });
    }
    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            if (mobileSearchInput) mobileSearchInput.value = '';
            projectSearchQuery = '';
            searchClearBtn.classList.remove('visible');
            if (mobileSearchClearBtn) mobileSearchClearBtn.classList.remove('visible');
            displayProjects();
            if (searchInput) searchInput.focus();
        });
    }

    // Mobile search input
    if (mobileSearchInput) {
        mobileSearchInput.addEventListener('input', (e) => {
            projectSearchQuery = e.target.value.toLowerCase();
            if (searchInput) searchInput.value = e.target.value;
            if (searchClearBtn) searchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            if (mobileSearchClearBtn) mobileSearchClearBtn.classList.toggle('visible', e.target.value.length > 0);
            displayProjects();
        });
    }
    if (mobileSearchClearBtn) {
        mobileSearchClearBtn.addEventListener('click', () => {
            if (mobileSearchInput) mobileSearchInput.value = '';
            if (searchInput) searchInput.value = '';
            projectSearchQuery = '';
            mobileSearchClearBtn.classList.remove('visible');
            if (searchClearBtn) searchClearBtn.classList.remove('visible');
            displayProjects();
            if (mobileSearchInput) mobileSearchInput.focus();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            projectSort = sortSelect.value;
            localStorage.setItem('projectSort', projectSort);
            displayProjects();
        });
    }
    if (showFilterSelect) {
        showFilterSelect.addEventListener('change', () => {
            projectShowFilter = showFilterSelect.value;
            localStorage.setItem('projectShowFilter', projectShowFilter);
            displayProjects();
        });
    }

    // Desktop sidebar collapse toggle
    // Desktop sidebar toggle
    // Desktop sidebar toggle
    const projToggleBtn = document.getElementById('projects-sidebar-toggle');
    if (projToggleBtn) {
        const projectsLayout = document.getElementById('projects-layout');
        if (projectsLayout.classList.contains('sidebar-collapsed')) projToggleBtn.classList.add('active');
        projToggleBtn.addEventListener('click', () => {
            const isCollapsed = projectsLayout.classList.toggle('sidebar-collapsed');
            projToggleBtn.classList.toggle('active', isCollapsed);
            localStorage.setItem('projectsSidebarCollapsed', isCollapsed);
        });
    }
}

// Render a single project card
function renderProjectCard(project) {
    const progress = project.pattern_count > 0
        ? Math.round((project.completed_count / project.pattern_count) * 100)
        : 0;

    const totalTime = formatTimeHumanReadable(project.total_timer_seconds || 0);

    const hashtagsHtml = project.hashtags?.map(h =>
        `<span class="pattern-hashtag" onclick="event.stopPropagation(); filterByHashtag('${escapeHtml(h.name)}', 'projects')">#${escapeHtml(h.name)}</span>`
    ).join('') || '';

    return `
        <div class="pattern-card project-card" onclick="openProjectView(${project.id})">
            <span class="project-badge">PROJECT</span>
            ${project.completed ? '<span class="completed-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
            ${!project.completed && project.is_current ? '<span class="current-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span>' : ''}
            ${project.is_favorite ? '<span class="favorite-badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></span>' : ''}

            <div class="pattern-thumbnail project-thumbnail" style="background: var(--card-bg);">
                ${project.thumbnail || project.pattern_count > 0
                    ? `<img src="${API_URL}/api/projects/${project.id}/thumbnail" alt="${escapeHtml(project.name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                       <div class="project-thumbnail-placeholder" style="display: none;">
                           <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                               <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                           </svg>
                       </div>`
                    : `<div class="project-thumbnail-placeholder">
                           <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                               <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                           </svg>
                       </div>`
                }
                ${project.in_progress_count ? `<div class="project-continue-overlay" onclick="event.stopPropagation(); continueProject(${project.id})" title="Continue working">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>` : ''}
                <div class="project-progress-mini">
                    <span>${project.completed_count}/${project.pattern_count}</span>
                    <div class="progress-bar-mini">
                        <div class="progress-fill" style="width: ${progress}%;"></div>
                    </div>
                    <span>${totalTime || '0h 0m'}</span>
                </div>
            </div>

            <h3 title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</h3>

            <p class="pattern-description" onclick="event.stopPropagation(); startInlineProjectDescEdit(this, ${project.id})" title="Click to edit">${project.description ? escapeHtml(project.description) : '<span class="add-description">+ Add description</span>'}</p>

            <div class="pattern-hashtags">${hashtagsHtml}</div>

            <div class="pattern-actions" onclick="event.stopPropagation()">
                <button class="action-btn ${project.is_current ? 'current' : ''}"
                        onclick="toggleProjectCurrent(${project.id}, ${!project.is_current})"
                        title="${project.is_current ? 'Remove from In Progress' : 'Mark In Progress'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${project.is_current ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                </button>
                <button class="action-btn ${project.is_favorite ? 'active favorite' : ''}"
                        onclick="toggleProjectFavorite(${project.id}, ${!project.is_favorite})"
                        title="Favorite">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${project.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>
                </button>
                <button class="action-btn ${project.completed ? 'completed' : ''}"
                        onclick="toggleProjectComplete(${project.id}, ${!project.completed})"
                        title="${project.completed ? 'Mark Incomplete' : 'Mark Complete'}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10" ${project.completed ? 'fill="currentColor"' : ''}></circle>
                        <polyline points="16 8 10 16 7 13" ${project.completed ? 'stroke="var(--card-bg, #1a1a2e)"' : ''}></polyline>
                    </svg>
                </button>
                <button class="action-btn" onclick="editProjectFromCard(${project.id})" title="Edit">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </button>
                <button class="action-btn ${enableDirectDelete ? 'delete' : 'archive'}" onclick="handleProjectCardDelete(this, ${project.id})" title="${enableDirectDelete ? 'Delete' : 'Archive'}">
                    <svg class="trash-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    <svg class="archive-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="21 8 21 21 3 21 3 8"></polyline>
                        <rect x="1" y="3" width="22" height="5"></rect>
                        <line x1="10" y1="12" x2="14" y2="12"></line>
                    </svg>
                    <svg class="confirm-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

// Show new project panel
function showNewProjectPanel() {
    const panel = document.getElementById('new-project-panel');
    const tabsNav = document.querySelector('.tabs');
    const allTabs = document.querySelectorAll('.tab-content');

    // Push history so back button works
    if (!isNavigatingBack) {
        history.pushState({ view: 'new-project' }, '', '#new-project');
    }

    if (panel) {
        panel.style.display = 'flex';
    }
    if (tabsNav) {
        tabsNav.style.display = 'none';
    }
    allTabs.forEach(tab => tab.style.display = 'none');

    // Clear form
    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-description').value = '';

    // Clear staged files and selected patterns for project
    projectStagedFiles = [];
    projectSelectedPatternIds = [];
    renderProjectStagedFiles();

    // Reset to "Add Existing" tab
    const tabBtns = document.querySelectorAll('.project-add-tab');
    tabBtns.forEach(t => t.classList.toggle('active', t.dataset.tab === 'existing'));
    const existingTab = document.getElementById('project-existing-tab');
    const importTab = document.getElementById('project-import-tab');
    if (existingTab) {
        existingTab.style.display = 'block';
        existingTab.classList.add('active');
    }
    if (importTab) {
        importTab.style.display = 'none';
        importTab.classList.remove('active');
    }

    // Reset filters to defaults
    const searchInput = document.getElementById('project-existing-search-input');
    const showFilter = document.getElementById('project-show-filter');
    const categoryFilter = document.getElementById('project-category-filter');
    const sortSelect = document.getElementById('project-sort-select');
    const showCompleted = document.getElementById('project-show-completed');
    const showCurrent = document.getElementById('project-show-current');
    const showPdf = document.getElementById('project-show-pdf');
    const showMarkdown = document.getElementById('project-show-markdown');

    if (searchInput) searchInput.value = '';
    if (showFilter) showFilter.value = 'all';
    if (sortSelect) sortSelect.value = 'date-desc';
    if (showCompleted) showCompleted.checked = true;
    if (showCurrent) showCurrent.checked = true;
    if (showPdf) showPdf.checked = true;
    if (showMarkdown) showMarkdown.checked = true;

    // Populate category filter and render patterns grid
    populateProjectCategoryFilter();
    if (categoryFilter) categoryFilter.value = 'all';
    renderProjectExistingGrid();

    // Render hashtag selector (use same one as pattern upload)
    const hashtagContainer = document.getElementById('new-project-hashtags-container');
    if (hashtagContainer) {
        hashtagContainer.innerHTML = createHashtagSelector('new-project', [], false);
    }
}

// Hide new project panel
function hideNewProjectPanel() {
    const panel = document.getElementById('new-project-panel');
    const tabsNav = document.querySelector('.tabs');

    if (panel) {
        panel.style.display = 'none';
    }
    if (tabsNav) {
        tabsNav.style.display = 'flex';
    }

    // Clear staged files, selected patterns, and thumbnail
    projectStagedFiles = [];
    projectSelectedPatternIds = [];
    clearThumbnailSelector('new-project');

    // Show active tab
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) {
        const tabId = activeTab.dataset.tab;
        const tabContent = document.getElementById(tabId);
        if (tabContent) {
            tabContent.style.display = 'block';
        }
    }
}

// Initialize project panel
function initProjectPanel() {
    // New project panel
    const closeNewProjectPanel = document.getElementById('close-new-project-panel');
    const cancelNewProject = document.getElementById('cancel-new-project');
    const saveNewProject = document.getElementById('save-new-project');

    if (closeNewProjectPanel) {
        closeNewProjectPanel.addEventListener('click', hideNewProjectPanel);
    }
    if (cancelNewProject) {
        cancelNewProject.addEventListener('click', hideNewProjectPanel);
    }
    if (saveNewProject) {
        saveNewProject.addEventListener('click', createProject);
    }

    // Initialize project panel tabs (Add Existing / Import New)
    initProjectPanelTabs();

    // Project drop zone for PDFs
    const projectDropZone = document.getElementById('project-drop-zone');
    const projectFileInput = document.getElementById('project-file-input');
    const projectBrowseBtn = document.getElementById('project-browse-btn');
    const projectClearStaged = document.getElementById('project-clear-staged');

    if (projectDropZone) {
        projectDropZone.addEventListener('click', (e) => {
            // Don't trigger file input if clicking browse button
            if (e.target !== projectBrowseBtn) {
                projectFileInput.click();
            }
        });

        projectDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            projectDropZone.classList.add('drag-over');
        });

        projectDropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            projectDropZone.classList.remove('drag-over');
        });

        projectDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            projectDropZone.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
            if (files.length > 0) {
                handleProjectFiles(files);
            }
        });
    }

    if (projectBrowseBtn) {
        projectBrowseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            projectFileInput.click();
        });
    }

    if (projectFileInput) {
        projectFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleProjectFiles(Array.from(e.target.files));
                projectFileInput.value = '';
            }
        });
    }

    if (projectClearStaged) {
        projectClearStaged.addEventListener('click', () => {
            projectStagedFiles = [];
            renderProjectStagedFiles();
        });
    }

    // Project detail view
    const closeProjectDetail = document.getElementById('close-project-detail');
    if (closeProjectDetail) {
        closeProjectDetail.addEventListener('click', closeProjectView);
    }

    // Add patterns modal
    const closeAddPatternsModal = document.getElementById('close-add-patterns-modal');
    const cancelAddPatterns = document.getElementById('cancel-add-patterns');
    const confirmAddPatterns = document.getElementById('confirm-add-patterns');

    if (closeAddPatternsModal) {
        closeAddPatternsModal.addEventListener('click', () => {
            document.getElementById('add-patterns-modal').style.display = 'none';
        });
    }
    if (cancelAddPatterns) {
        cancelAddPatterns.addEventListener('click', () => {
            document.getElementById('add-patterns-modal').style.display = 'none';
        });
    }
    if (confirmAddPatterns) {
        confirmAddPatterns.addEventListener('click', confirmAddPatternsToProject);
    }

    // Add patterns button
    const addPatternsBtn = document.getElementById('add-patterns-to-project-btn');
    if (addPatternsBtn) {
        addPatternsBtn.addEventListener('click', showAddPatternsModal);
    }

    // Project notes modal
    const closeProjectNotesModal = document.getElementById('close-project-notes-modal');
    const cancelProjectNotes = document.getElementById('cancel-project-notes');
    const saveProjectNotes = document.getElementById('save-project-notes');
    const projectNotesBtn = document.getElementById('project-notes-btn');

    if (closeProjectNotesModal) {
        closeProjectNotesModal.addEventListener('click', () => {
            document.getElementById('project-notes-modal').style.display = 'none';
        });
    }
    if (cancelProjectNotes) {
        cancelProjectNotes.addEventListener('click', () => {
            document.getElementById('project-notes-modal').style.display = 'none';
        });
    }
    if (saveProjectNotes) {
        saveProjectNotes.addEventListener('click', saveCurrentProjectNotes);
    }
    if (projectNotesBtn) {
        projectNotesBtn.addEventListener('click', showProjectNotesModal);
    }

    // Edit project modal
    const closeEditProjectModal = document.getElementById('close-edit-project-modal');
    const cancelEditProject = document.getElementById('cancel-edit-project');
    const saveEditProject = document.getElementById('save-edit-project');
    const deleteProjectBtn = document.getElementById('delete-project-btn');
    const projectEditBtn = document.getElementById('project-edit-btn');

    if (closeEditProjectModal) {
        closeEditProjectModal.addEventListener('click', () => {
            document.getElementById('edit-project-modal').style.display = 'none';
        });
    }
    if (cancelEditProject) {
        cancelEditProject.addEventListener('click', () => {
            document.getElementById('edit-project-modal').style.display = 'none';
        });
    }
    if (saveEditProject) {
        saveEditProject.addEventListener('click', saveProjectEdits);
    }
    if (deleteProjectBtn) {
        deleteProjectBtn.addEventListener('click', deleteCurrentProject);
    }
    if (projectEditBtn) {
        projectEditBtn.addEventListener('click', showEditProjectModal);
    }

    // Close edit project modal when clicking outside
    const editProjectModal = document.getElementById('edit-project-modal');
    if (editProjectModal) {
        editProjectModal.addEventListener('click', (e) => {
            if (e.target === editProjectModal) {
                editProjectModal.style.display = 'none';
            }
        });
    }

    // Search in add patterns modal
    const addPatternsSearch = document.getElementById('add-patterns-search-input');
    if (addPatternsSearch) {
        addPatternsSearch.addEventListener('input', filterAddPatternsGrid);
    }

    // Add patterns modal tabs
    const addModalExistingTabBtn = document.getElementById('add-modal-existing-tab-btn');
    const addModalImportTabBtn = document.getElementById('add-modal-import-tab-btn');

    if (addModalExistingTabBtn) {
        addModalExistingTabBtn.addEventListener('click', () => {
            addModalExistingTabBtn.classList.add('active');
            addModalImportTabBtn.classList.remove('active');
            document.getElementById('add-modal-existing-tab').style.display = 'block';
            document.getElementById('add-modal-import-tab').style.display = 'none';
        });
    }
    if (addModalImportTabBtn) {
        addModalImportTabBtn.addEventListener('click', () => {
            addModalImportTabBtn.classList.add('active');
            addModalExistingTabBtn.classList.remove('active');
            document.getElementById('add-modal-import-tab').style.display = 'block';
            document.getElementById('add-modal-existing-tab').style.display = 'none';
        });
    }

    // Add modal drop zone
    const addModalDropZone = document.getElementById('add-modal-drop-zone');
    const addModalFileInput = document.getElementById('add-modal-file-input');
    const addModalBrowseBtn = document.getElementById('add-modal-browse-btn');
    const addModalClearStaged = document.getElementById('add-modal-clear-staged');

    if (addModalDropZone) {
        addModalDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            addModalDropZone.classList.add('dragover');
        });
        addModalDropZone.addEventListener('dragleave', () => {
            addModalDropZone.classList.remove('dragover');
        });
        addModalDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            addModalDropZone.classList.remove('dragover');
            const files = Array.from(e.dataTransfer.files);
            handleAddModalFiles(files);
        });
    }
    if (addModalBrowseBtn && addModalFileInput) {
        addModalBrowseBtn.addEventListener('click', () => addModalFileInput.click());
        addModalFileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            handleAddModalFiles(files);
            e.target.value = '';
        });
    }
    if (addModalClearStaged) {
        addModalClearStaged.addEventListener('click', () => {
            addModalStagedFiles = [];
            renderAddModalStagedFiles();
        });
    }
}

// Create a new project
async function createProject() {
    const nameInput = document.getElementById('new-project-name');
    const descInput = document.getElementById('new-project-description');
    const name = nameInput.value.trim();
    const description = descInput.value.trim();

    if (!name) {
        alert('Please enter a project name');
        return;
    }

    // Get selected hashtags (using same selector format as pattern upload)
    const hashtagIds = getSelectedHashtagIds('new-project');

    try {
        const response = await fetch(`${API_URL}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, hashtagIds })
        });

        if (!response.ok) throw new Error('Failed to create project');

        const project = await response.json();

        // Collect all pattern IDs to add (start with selected existing patterns)
        const patternIds = [...projectSelectedPatternIds];

        // Upload staged files and add their IDs
        if (projectStagedFiles.length > 0) {
            for (const staged of projectStagedFiles) {
                const formData = new FormData();
                formData.append('pattern', staged.file);
                formData.append('name', staged.name);
                formData.append('category', staged.category);

                const uploadResponse = await fetch(`${API_URL}/api/patterns`, {
                    method: 'POST',
                    body: formData
                });

                if (uploadResponse.ok) {
                    const pattern = await uploadResponse.json();
                    patternIds.push(pattern.id);
                }
            }
        }

        // Add all patterns (existing + newly uploaded) to project
        if (patternIds.length > 0) {
            await fetch(`${API_URL}/api/projects/${project.id}/patterns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patternIds })
            });
        }

        // Upload thumbnail if one was selected
        const thumbnailFile = getThumbnailFile('new-project');
        if (thumbnailFile) {
            const thumbFormData = new FormData();
            thumbFormData.append('thumbnail', thumbnailFile);
            await fetch(`${API_URL}/api/projects/${project.id}/thumbnail`, {
                method: 'POST',
                body: thumbFormData
            });
        }

        hideNewProjectPanel();
        await loadPatterns();
        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();

        // Open the newly created project
        openProjectView(project.id);
    } catch (error) {
        console.error('Error creating project:', error);
        alert('Error creating project: ' + error.message);
    }
}

// Open project detail view
async function openProjectView(projectId, pushHistory = true) {
    currentProjectId = projectId;

    // Push current view to navigation history
    if (pushHistory && !isNavigatingBack) {
        const currentView = getCurrentView();
        if (currentView && !currentView.startsWith('project/')) {
            navigationHistory.push(currentView);
        }
        history.pushState({ view: `project/${projectId}` }, '', `#project/${projectId}`);
    }

    // Track last opened (fire-and-forget)
    fetch(`${API_URL}/api/projects/${projectId}/opened`, { method: 'POST' }).catch(() => {});

    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}`);
        if (!response.ok) throw new Error('Failed to fetch project');

        const project = await response.json();

        // Hide tabs, viewers, and other content
        const tabsNav = document.querySelector('.tabs');
        const allTabs = document.querySelectorAll('.tab-content');
        const projectDetailView = document.getElementById('project-detail-view');
        const pdfViewer = document.getElementById('pdf-viewer-container');
        const markdownViewer = document.getElementById('markdown-viewer-container');

        if (tabsNav) tabsNav.style.display = 'none';
        allTabs.forEach(tab => tab.style.display = 'none');
        if (pdfViewer) pdfViewer.style.display = 'none';
        if (markdownViewer) markdownViewer.style.display = 'none';
        if (projectDetailView) projectDetailView.style.display = 'flex';

        // Populate project info
        document.getElementById('project-detail-name').textContent = project.name;
        document.getElementById('project-detail-description').textContent = project.description || '';

        // Progress
        const progress = project.pattern_count > 0
            ? Math.round((project.completed_count / project.pattern_count) * 100)
            : 0;
        document.getElementById('project-progress-text').textContent =
            `${project.completed_count}/${project.pattern_count} complete`;
        document.getElementById('project-progress-fill').style.width = `${progress}%`;
        document.getElementById('project-total-time').textContent =
            `Total time: ${formatTimeHumanReadable(project.total_timer_seconds || 0)}`;

        // Hashtags
        const hashtagsContainer = document.getElementById('project-detail-hashtags');
        if (hashtagsContainer) {
            hashtagsContainer.innerHTML = project.hashtags?.map(h =>
                `<span class="pattern-hashtag">#${escapeHtml(h.name)}</span>`
            ).join('') || '';
        }

        // Store and render patterns list
        currentProjectPatterns = project.patterns || [];
        renderProjectPatterns(currentProjectPatterns);

    } catch (error) {
        console.error('Error opening project:', error);
        alert('Error opening project: ' + error.message);
    }
}

// Close project detail view
async function closeProjectView() {
    currentProjectId = null;
    currentProjectPatterns = [];

    // Reset reorder mode if active
    if (projectReorderMode) {
        projectReorderMode = false;
        const btn = document.getElementById('reorder-patterns-btn');
        if (btn) {
            btn.classList.remove('active');
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="3" y1="12" x2="21" y2="12"></line>
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
                Reorder
            `;
        }
    }

    const projectDetailView = document.getElementById('project-detail-view');
    if (projectDetailView) projectDetailView.style.display = 'none';

    await navigateBack();
}

// Render patterns in project detail view
function renderProjectPatterns(patterns) {
    const container = document.getElementById('project-patterns-list');
    if (!container) return;

    if (patterns.length === 0) {
        container.innerHTML = '<p class="empty-state">No patterns in this project yet. Click "Add Patterns" to get started!</p>';
        return;
    }

    container.innerHTML = patterns.map((pattern, index) => {
        const statusClass = pattern.project_status === 'completed' ? 'status-completed'
            : pattern.project_status === 'in_progress' ? 'status-in-progress'
            : 'status-pending';

        const dragHandle = projectReorderMode ? `
            <div class="project-pattern-drag-handle" title="Drag to reorder">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="8" y1="6" x2="16" y2="6"></line>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                    <line x1="8" y1="18" x2="16" y2="18"></line>
                </svg>
            </div>
        ` : '';

        return `
            <div class="project-pattern-item ${statusClass}${projectReorderMode ? ' reorder-mode' : ''}"
                 data-pattern-id="${pattern.id}"
                 draggable="${projectReorderMode}"
                 onclick="${projectReorderMode ? '' : `openPDFViewer(${pattern.id})`}"
                 ondragstart="handlePatternDragStart(event)"
                 ondragover="handlePatternDragOver(event)"
                 ondrop="handlePatternDrop(event)"
                 ondragend="handlePatternDragEnd(event)">
                ${dragHandle}
                <div class="project-pattern-position">${index + 1}</div>
                <div class="project-pattern-thumbnail">
                    ${pattern.thumbnail
                        ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" alt="${escapeHtml(pattern.name)}">`
                        : `<div class="thumbnail-placeholder-small">
                               <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                   <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                   <polyline points="14 2 14 8 20 8"></polyline>
                               </svg>
                           </div>`
                    }
                </div>
                <div class="project-pattern-info">
                    <h4>${escapeHtml(pattern.name)}</h4>
                    <span class="project-pattern-time">${formatTimeHumanReadable(pattern.timer_seconds || 0)}</span>
                </div>
                <div class="project-pattern-actions"${projectReorderMode ? ' style="display: none;"' : ''}>
                    <select class="project-pattern-status-select" onclick="event.stopPropagation()" onchange="event.stopPropagation(); updatePatternStatusInProject(${pattern.id}, this.value)">
                        <option value="pending" ${pattern.project_status === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="in_progress" ${pattern.project_status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                        <option value="completed" ${pattern.project_status === 'completed' ? 'selected' : ''}>Completed</option>
                    </select>
                    <button class="btn btn-sm btn-danger project-pattern-remove" onclick="event.stopPropagation(); removePatternFromProject(${pattern.id}, this)" title="Remove from project">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Toggle project reorder mode
let draggedPatternId = null;

function toggleProjectReorderMode() {
    projectReorderMode = !projectReorderMode;

    const btn = document.getElementById('reorder-patterns-btn');
    if (btn) {
        if (projectReorderMode) {
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Done
            `;
            btn.classList.add('active');
        } else {
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="3" y1="12" x2="21" y2="12"></line>
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
                Reorder
            `;
            btn.classList.remove('active');
        }
    }

    // Re-render patterns with/without drag handles
    if (currentProjectPatterns.length > 0) {
        renderProjectPatterns(currentProjectPatterns);
    }
}

// Drag and drop handlers for pattern reordering
function handlePatternDragStart(e) {
    draggedPatternId = parseInt(e.target.closest('.project-pattern-item').dataset.patternId);
    e.target.closest('.project-pattern-item').classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handlePatternDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const item = e.target.closest('.project-pattern-item');
    if (!item || parseInt(item.dataset.patternId) === draggedPatternId) return;

    const container = document.getElementById('project-patterns-list');
    const draggingItem = container.querySelector('.dragging');
    if (!draggingItem) return;

    const items = [...container.querySelectorAll('.project-pattern-item:not(.dragging)')];
    const targetIndex = items.indexOf(item);

    // Determine if we should insert before or after
    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (e.clientY < midY) {
        item.parentNode.insertBefore(draggingItem, item);
    } else {
        item.parentNode.insertBefore(draggingItem, item.nextSibling);
    }

    // Update position numbers
    updatePositionNumbers();
}

function handlePatternDrop(e) {
    e.preventDefault();
}

function handlePatternDragEnd(e) {
    e.target.closest('.project-pattern-item')?.classList.remove('dragging');

    // Get new order and save
    const container = document.getElementById('project-patterns-list');
    const items = container.querySelectorAll('.project-pattern-item');
    const patternIds = [...items].map(item => parseInt(item.dataset.patternId));

    saveProjectPatternOrder(patternIds);
    draggedPatternId = null;
}

function updatePositionNumbers() {
    const container = document.getElementById('project-patterns-list');
    const items = container.querySelectorAll('.project-pattern-item');
    items.forEach((item, index) => {
        const posEl = item.querySelector('.project-pattern-position');
        if (posEl) posEl.textContent = index + 1;
    });
}

async function saveProjectPatternOrder(patternIds) {
    if (!currentProjectId) return;

    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/patterns/reorder`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patternIds })
        });

        if (!response.ok) throw new Error('Failed to save order');

        // Update local patterns order
        const patternMap = new Map(currentProjectPatterns.map(p => [p.id, p]));
        currentProjectPatterns = patternIds.map(id => patternMap.get(id)).filter(Boolean);
    } catch (error) {
        console.error('Error saving pattern order:', error);
    }
}

// Toggle project current status
async function toggleProjectCurrent(projectId, isCurrent) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}/current`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isCurrent })
        });

        if (!response.ok) throw new Error('Failed to update project');

        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();
    } catch (error) {
        console.error('Error toggling project current:', error);
    }
}

// Toggle project favorite status
async function toggleProjectFavorite(projectId, isFavorite) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}/favorite`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });

        if (!response.ok) throw new Error('Failed to update project');

        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();
    } catch (error) {
        console.error('Error toggling project favorite:', error);
    }
}

// Toggle project complete status
async function toggleProjectComplete(projectId, completed) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}/complete`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed })
        });

        if (!response.ok) throw new Error('Failed to update project');

        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();
    } catch (error) {
        console.error('Error toggling project complete:', error);
    }
}

// Continue project - navigate to the current in-progress pattern
async function continueProject(projectId) {
    try {
        // Fetch patterns for this project
        const response = await fetch(`${API_URL}/api/projects/${projectId}/patterns`);
        if (!response.ok) throw new Error('Failed to fetch project patterns');

        const patterns = await response.json();
        if (patterns.length === 0) {
            showToast('No patterns in this project');
            return;
        }

        // Find patterns marked as in_progress
        const inProgressPatterns = patterns.filter(p => p.project_status === 'in_progress');

        if (inProgressPatterns.length === 0) {
            showToast('No patterns marked as in progress');
            return;
        }

        // If one in_progress pattern, use that; if multiple, use first by position
        const targetPattern = inProgressPatterns.length === 1
            ? inProgressPatterns[0]
            : inProgressPatterns.reduce((first, current) =>
                current.position < first.position ? current : first
            );

        await openPDFViewer(targetPattern.id);
    } catch (error) {
        console.error('Error continuing project:', error);
        showToast('Failed to continue project');
    }
}

// Edit project from card (sets currentProjectId and opens edit modal)
function editProjectFromCard(projectId) {
    currentProjectId = projectId;
    showEditProjectModal();
}

// Handle project card delete/archive button
function handleProjectCardDelete(btn, projectId) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.title = enableDirectDelete ? 'Click again to delete' : 'Click again to archive';
        return;
    }

    // Second click - archive or delete based on setting
    if (enableDirectDelete) {
        deleteProject(projectId);
    } else {
        archiveProject(projectId);
    }
}

async function archiveProject(projectId) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}/archive`, {
            method: 'POST'
        });

        if (response.ok) {
            showToast('Project archived');
            await loadProjects();
            await loadCurrentProjects();
            displayCurrentPatterns();
            displayProjects();
        } else {
            const error = await response.json();
            console.error('Error archiving project:', error.error);
            showToast('Error archiving project', 'error');
        }
    } catch (error) {
        console.error('Error archiving project:', error);
        showToast('Error archiving project', 'error');
    }
}

async function deleteProject(projectId) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showToast('Project deleted');
            await loadProjects();
            await loadCurrentProjects();
            displayCurrentPatterns();
            displayProjects();
        } else {
            const error = await response.json();
            console.error('Error deleting project:', error.error);
            showToast('Error deleting project', 'error');
        }
    } catch (error) {
        console.error('Error deleting project:', error);
        showToast('Error deleting project', 'error');
    }
}

async function restoreProject(projectId) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${projectId}/restore`, {
            method: 'POST'
        });

        if (response.ok) {
            showToast('Project restored');
            await loadArchivedProjectsUI();
            await loadProjects();
            await loadCurrentProjects();
            updateTabCounts();
        } else {
            const error = await response.json();
            console.error('Error restoring project:', error.error);
            showToast('Error restoring project', 'error');
        }
    } catch (error) {
        console.error('Error restoring project:', error);
        showToast('Error restoring project', 'error');
    }
}

// Show add patterns modal
function showAddPatternsModal() {
    const modal = document.getElementById('add-patterns-modal');
    const searchInput = document.getElementById('add-patterns-search-input');

    if (modal) modal.style.display = 'flex';
    if (searchInput) searchInput.value = '';

    // Reset to "Add Existing" tab
    const existingTabBtn = document.getElementById('add-modal-existing-tab-btn');
    const importTabBtn = document.getElementById('add-modal-import-tab-btn');
    const existingTab = document.getElementById('add-modal-existing-tab');
    const importTab = document.getElementById('add-modal-import-tab');

    if (existingTabBtn) existingTabBtn.classList.add('active');
    if (importTabBtn) importTabBtn.classList.remove('active');
    if (existingTab) existingTab.style.display = 'block';
    if (importTab) importTab.style.display = 'none';

    // Clear staged files
    addModalStagedFiles = [];
    renderAddModalStagedFiles();

    // Render available patterns (not already in project)
    renderAddPatternsGrid();
}

// Render patterns available to add
async function renderAddPatternsGrid() {
    const grid = document.getElementById('add-patterns-grid');
    if (!grid) return;

    // Get current project's patterns
    let projectPatternIds = [];
    if (currentProjectId) {
        try {
            const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/patterns`);
            if (response.ok) {
                const projectPatterns = await response.json();
                projectPatternIds = projectPatterns.map(p => p.id);
            }
        } catch (error) {
            console.error('Error fetching project patterns:', error);
        }
    }

    // Filter out patterns already in project
    const availablePatterns = patterns.filter(p => !projectPatternIds.includes(p.id));

    if (availablePatterns.length === 0) {
        grid.innerHTML = '<p class="empty-state">All patterns are already in this project!</p>';
        return;
    }

    grid.innerHTML = availablePatterns.map(pattern => `
        <div class="add-pattern-item" data-pattern-id="${pattern.id}" data-pattern-name="${escapeHtml(pattern.name.toLowerCase())}">
            <input type="checkbox" id="add-pattern-${pattern.id}" class="add-pattern-checkbox">
            <label for="add-pattern-${pattern.id}" class="add-pattern-label">
                <div class="add-pattern-thumb">
                    ${pattern.thumbnail
                        ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" alt="${escapeHtml(pattern.name)}">`
                        : `<div class="thumbnail-placeholder-small">
                               <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                   <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                   <polyline points="14 2 14 8 20 8"></polyline>
                               </svg>
                           </div>`
                    }
                </div>
                <span class="add-pattern-name">${escapeHtml(pattern.name)}</span>
            </label>
        </div>
    `).join('');
}

// Filter add patterns grid by search
function filterAddPatternsGrid() {
    const searchInput = document.getElementById('add-patterns-search-input');
    const query = searchInput.value.toLowerCase();
    const items = document.querySelectorAll('.add-pattern-item');

    items.forEach(item => {
        const name = item.dataset.patternName || '';
        item.style.display = name.includes(query) ? 'flex' : 'none';
    });
}

// Confirm adding selected patterns to project
async function confirmAddPatternsToProject() {
    const checkboxes = document.querySelectorAll('.add-pattern-checkbox:checked');
    const existingPatternIds = Array.from(checkboxes).map(cb => {
        const id = cb.id.replace('add-pattern-', '');
        return parseInt(id);
    });

    // Check if we have anything to add
    if (existingPatternIds.length === 0 && addModalStagedFiles.length === 0) {
        showToast('Please select patterns or import PDFs', 'warning');
        return;
    }

    try {
        // Collect all pattern IDs to add
        const patternIds = [...existingPatternIds];

        // Upload any staged files first
        for (const staged of addModalStagedFiles) {
            const formData = new FormData();
            formData.append('pdf', staged.file);
            formData.append('category', staged.category);

            const uploadResponse = await fetch(`${API_URL}/api/patterns`, {
                method: 'POST',
                body: formData
            });

            if (uploadResponse.ok) {
                const newPattern = await uploadResponse.json();
                patternIds.push(newPattern.id);
            }
        }

        // Add all patterns to project
        if (patternIds.length > 0) {
            const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/patterns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patternIds })
            });

            if (!response.ok) throw new Error('Failed to add patterns');
        }

        document.getElementById('add-patterns-modal').style.display = 'none';
        addModalStagedFiles = [];

        // Refresh patterns and project view
        await loadPatterns();
        await openProjectView(currentProjectId);
        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();

        const totalAdded = patternIds.length;
        showToast(`Added ${totalAdded} pattern${totalAdded !== 1 ? 's' : ''} to project`, 'success');
    } catch (error) {
        console.error('Error adding patterns to project:', error);
        showToast('Error adding patterns: ' + error.message, 'error');
    }
}

// Handle files dropped/selected in add patterns modal
async function handleAddModalFiles(files) {
    const pdfFiles = files.filter(f => f.type === 'application/pdf');

    for (const file of pdfFiles) {
        // Check if already staged
        if (addModalStagedFiles.some(s => s.file.name === file.name)) {
            showToast(`"${file.name}" is already staged`, 'warning');
            continue;
        }

        const baseName = file.name.replace('.pdf', '');

        // Check for existing pattern in library
        const existingPattern = patterns.find(p =>
            p.name.toLowerCase() === baseName.toLowerCase() ||
            p.name.toLowerCase().includes(baseName.toLowerCase()) ||
            baseName.toLowerCase().includes(p.name.toLowerCase())
        );

        if (existingPattern) {
            const choice = await showDuplicatePatternDialog(file.name, existingPattern);

            if (choice === 'existing') {
                // Check the checkbox for this pattern
                const checkbox = document.getElementById(`add-pattern-${existingPattern.id}`);
                if (checkbox && !checkbox.checked) {
                    checkbox.checked = true;
                    showToast(`Selected "${existingPattern.name}" from library`, 'success');
                } else {
                    showToast(`"${existingPattern.name}" already selected`, 'warning');
                }
                continue;
            } else if (choice === 'cancel') {
                continue;
            }
            // choice === 'import' falls through to stage the file
        }

        addModalStagedFiles.push({
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            file: file,
            name: baseName,
            category: getDefaultCategory()
        });
    }

    renderAddModalStagedFiles();
}

// Render staged files in add patterns modal
function renderAddModalStagedFiles() {
    const container = document.getElementById('add-modal-staged-files');
    const list = document.getElementById('add-modal-staged-list');
    const countEl = document.getElementById('add-modal-staged-count');

    if (!container || !list) return;

    if (addModalStagedFiles.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    if (countEl) countEl.textContent = addModalStagedFiles.length;

    const categoryOptions = allCategories.map(cat =>
        `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`
    ).join('');

    list.innerHTML = addModalStagedFiles.map(staged => `
        <div class="project-staged-item" data-staged-id="${staged.id}">
            <div class="staged-item-info">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span class="staged-item-name">${escapeHtml(staged.name)}</span>
            </div>
            <div class="staged-item-controls">
                <select class="staged-item-category" onchange="updateAddModalStagedCategory('${staged.id}', this.value)">
                    ${categoryOptions}
                </select>
                <button type="button" class="btn btn-secondary btn-sm" onclick="removeAddModalStagedFile('${staged.id}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    // Set selected categories
    addModalStagedFiles.forEach(staged => {
        const select = list.querySelector(`[data-staged-id="${staged.id}"] .staged-item-category`);
        if (select) select.value = staged.category;
    });
}

// Update category for staged file in add modal
function updateAddModalStagedCategory(stagedId, category) {
    const staged = addModalStagedFiles.find(s => s.id === stagedId);
    if (staged) staged.category = category;
}

// Remove staged file from add modal
function removeAddModalStagedFile(stagedId) {
    addModalStagedFiles = addModalStagedFiles.filter(s => s.id !== stagedId);
    renderAddModalStagedFiles();
}

// Remove pattern from current project
async function removePatternFromProject(patternId, btn) {
    // First click - show confirm state
    if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
        btn.title = 'Click again to confirm';

        // Reset after 3 seconds
        setTimeout(() => {
            if (btn.classList.contains('confirm')) {
                btn.classList.remove('confirm');
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>`;
                btn.title = 'Remove from project';
            }
        }, 3000);
        return;
    }

    // Second click - actually remove
    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/patterns/${patternId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to remove pattern');

        // Refresh all project views (projects tab, in-progress page, detail view)
        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();
        await openProjectView(currentProjectId, false);
    } catch (error) {
        console.error('Error removing pattern from project:', error);
    }
}

// Update pattern status within project
async function updatePatternStatusInProject(patternId, status) {
    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/patterns/${patternId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });

        if (!response.ok) throw new Error('Failed to update pattern status');

        // Refresh all project views (projects tab, in-progress page, detail view)
        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();
        await openProjectView(currentProjectId, false);
    } catch (error) {
        console.error('Error updating pattern status:', error);
        alert('Error updating status: ' + error.message);
    }
}

// Show project notes modal
async function showProjectNotesModal() {
    const modal = document.getElementById('project-notes-modal');
    const textarea = document.getElementById('project-notes-textarea');

    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/notes`);
        if (response.ok) {
            const data = await response.json();
            textarea.value = data.notes || '';
        }
    } catch (error) {
        console.error('Error fetching project notes:', error);
    }

    if (modal) modal.style.display = 'flex';
}

// Save project notes
async function saveCurrentProjectNotes() {
    const textarea = document.getElementById('project-notes-textarea');
    const notes = textarea.value;

    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });

        if (!response.ok) throw new Error('Failed to save notes');

        document.getElementById('project-notes-modal').style.display = 'none';
    } catch (error) {
        console.error('Error saving project notes:', error);
        alert('Error saving notes: ' + error.message);
    }
}

// Show edit project modal
async function showEditProjectModal() {
    const modal = document.getElementById('edit-project-modal');

    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}`);
        if (!response.ok) throw new Error('Failed to fetch project');

        const project = await response.json();

        document.getElementById('edit-project-name').value = project.name;
        document.getElementById('edit-project-description').value = project.description || '';

        // Render hashtag selector with current selections
        const selectedHashtagIds = project.hashtags?.map(h => h.id) || [];
        const hashtagContainer = document.getElementById('edit-project-hashtag-selector');
        if (hashtagContainer) {
            hashtagContainer.innerHTML = createHashtagSelector('edit-project', selectedHashtagIds, false);
        }

        // Thumbnail preview - use same style as pattern edit
        const previewContainer = document.getElementById('edit-project-thumbnail-preview');
        const placeholder = previewContainer.querySelector('.thumbnail-selector-placeholder');

        if (project.thumbnail || project.pattern_count > 0) {
            previewContainer.style.backgroundImage = `url(${API_URL}/api/projects/${currentProjectId}/thumbnail?t=${Date.now()})`;
            previewContainer.style.backgroundSize = 'cover';
            previewContainer.style.backgroundPosition = 'center';
            if (placeholder) placeholder.style.display = 'none';
        } else {
            previewContainer.style.backgroundImage = '';
            if (placeholder) placeholder.style.display = 'block';
        }

        if (modal) modal.style.display = 'flex';
    } catch (error) {
        console.error('Error showing edit project modal:', error);
    }
}

// Save project edits
async function saveProjectEdits() {
    const name = document.getElementById('edit-project-name').value.trim();
    const description = document.getElementById('edit-project-description').value.trim();
    const hashtagIds = getSelectedHashtagIds('edit-project');

    if (!name) {
        alert('Project name is required');
        return;
    }

    try {
        // Update project details
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
        });

        if (!response.ok) throw new Error('Failed to update project');

        // Update hashtags
        await fetch(`${API_URL}/api/projects/${currentProjectId}/hashtags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashtagIds })
        });

        // Handle thumbnail upload/clear
        const thumbnailPreview = document.getElementById('edit-project-thumbnail-preview');
        if (thumbnailPreview) {
            if (thumbnailPreview.dataset.thumbnailCleared === 'true') {
                // Clear thumbnail
                await fetch(`${API_URL}/api/projects/${currentProjectId}/thumbnail`, {
                    method: 'DELETE'
                });
            } else if (thumbnailPreview.dataset.thumbnailBlob) {
                // Upload new thumbnail
                const dataUrl = thumbnailPreview.dataset.thumbnailBlob;
                const blob = await (await fetch(dataUrl)).blob();
                const formData = new FormData();
                formData.append('thumbnail', blob, 'thumbnail.png');

                await fetch(`${API_URL}/api/projects/${currentProjectId}/thumbnail`, {
                    method: 'POST',
                    body: formData
                });
            }
        }

        document.getElementById('edit-project-modal').style.display = 'none';

        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();

        // If already viewing this project, refresh without navigation; otherwise open it
        const projectDetailView = document.getElementById('project-detail-view');
        if (projectDetailView && projectDetailView.style.display !== 'none') {
            await openProjectView(currentProjectId, false);
        }
    } catch (error) {
        console.error('Error saving project edits:', error);
        alert('Error saving project: ' + error.message);
    }
}

// Delete current project
async function deleteCurrentProject() {
    if (!confirm('Are you sure you want to delete this project? The patterns will remain in your library.')) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/projects/${currentProjectId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to delete project');

        document.getElementById('edit-project-modal').style.display = 'none';
        closeProjectView();
        await loadProjects();
        await loadCurrentProjects();
        displayCurrentPatterns();
    } catch (error) {
        console.error('Error deleting project:', error);
        alert('Error deleting project: ' + error.message);
    }
}

// Helper to format time in human readable format (Xh Xm)
// Handle files dropped/selected for project creation
async function handleProjectFiles(files) {
    const pdfFiles = files.filter(f => f.type === 'application/pdf');

    for (const file of pdfFiles) {
        // Check if already staged
        const alreadyStaged = projectStagedFiles.some(f =>
            f.file.name.toLowerCase() === file.name.toLowerCase()
        );

        if (alreadyStaged) {
            showToast(`${file.name} is already staged`, 'warning');
            continue;
        }

        const baseName = file.name.replace('.pdf', '');

        // Check if pattern with similar name exists in library
        const existingPattern = patterns.find(p =>
            p.name.toLowerCase() === baseName.toLowerCase() ||
            p.name.toLowerCase().includes(baseName.toLowerCase()) ||
            baseName.toLowerCase().includes(p.name.toLowerCase())
        );

        if (existingPattern) {
            // Ask user what they want to do
            const choice = await showDuplicatePatternDialog(file.name, existingPattern);

            if (choice === 'existing') {
                // Add existing pattern to selected list
                if (!projectSelectedPatternIds.includes(existingPattern.id)) {
                    projectSelectedPatternIds.push(existingPattern.id);
                    updateProjectSelectedCount();
                    showToast(`Added "${existingPattern.name}" from library`, 'success');
                } else {
                    showToast(`"${existingPattern.name}" already selected`, 'warning');
                }
                continue;
            } else if (choice === 'cancel') {
                continue;
            }
            // choice === 'import' falls through to stage the file
        }

        projectStagedFiles.push({
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            file: file,
            name: baseName,
            category: getDefaultCategory()
        });
    }

    renderProjectStagedFiles();
}

// Show dialog when imported file matches existing pattern
function showDuplicatePatternDialog(fileName, existingPattern) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 450px;">
                <div class="modal-header">
                    <h3>Pattern Already Exists</h3>
                </div>
                <div class="modal-body">
                    <p style="margin-bottom: 12px;">A pattern similar to "<strong>${escapeHtml(fileName)}</strong>" already exists in your library:</p>
                    <div style="background: var(--bg-color); padding: 10px; border-radius: 6px; margin-bottom: 16px;">
                        <strong>${escapeHtml(existingPattern.name)}</strong>
                        ${existingPattern.category ? `<span style="color: var(--text-muted); margin-left: 8px;">(${escapeHtml(existingPattern.category)})</span>` : ''}
                    </div>
                    <p>What would you like to do?</p>
                </div>
                <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-start;">
                    <button class="btn btn-secondary btn-sm" data-choice="cancel">Skip</button>
                    <button class="btn btn-secondary btn-sm" data-choice="import">Import Anyway</button>
                    <button class="btn btn-primary btn-sm" data-choice="existing">Use Existing</button>
                </div>
            </div>
        `;

        modal.addEventListener('click', (e) => {
            const choice = e.target.dataset.choice;
            if (choice) {
                modal.remove();
                resolve(choice);
            } else if (e.target === modal) {
                modal.remove();
                resolve('cancel');
            }
        });

        document.body.appendChild(modal);
    });
}

// Render staged files for project creation with category dropdowns
function renderProjectStagedFiles() {
    const container = document.getElementById('project-staged-files');
    const list = document.getElementById('project-staged-list');
    const countEl = document.getElementById('project-staged-count');

    if (!container || !list) return;

    if (projectStagedFiles.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    countEl.textContent = projectStagedFiles.length;

    list.innerHTML = projectStagedFiles.map(staged => `
        <div class="project-staged-item" data-file-id="${staged.id}">
            <div class="project-staged-item-header">
                <span class="staged-item-name">${escapeHtml(staged.file.name)}</span>
                <button class="staged-item-remove" onclick="removeProjectStagedFile('${staged.id}')" title="Remove">×</button>
            </div>
            <div class="project-staged-item-category">
                <label>Category:</label>
                ${createCategoryDropdown('project-staged-' + staged.id, staged.category)}
            </div>
        </div>
    `).join('');
}

// Remove a staged file from project
function removeProjectStagedFile(fileId) {
    projectStagedFiles = projectStagedFiles.filter(f => f.id !== fileId);
    renderProjectStagedFiles();
}

// Update staged file category
function updateProjectStagedFileCategory(fileId, category) {
    const staged = projectStagedFiles.find(f => f.id === fileId);
    if (staged) {
        staged.category = category;
    }
}

// Initialize project panel tabs
function initProjectPanelTabs() {
    const tabs = document.querySelectorAll('.project-add-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Update tab button states
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Show/hide tab content
            const tabId = tab.dataset.tab;
            const existingTab = document.getElementById('project-existing-tab');
            const importTab = document.getElementById('project-import-tab');

            if (existingTab) {
                existingTab.style.display = tabId === 'existing' ? 'block' : 'none';
                existingTab.classList.toggle('active', tabId === 'existing');
            }
            if (importTab) {
                importTab.style.display = tabId === 'import' ? 'block' : 'none';
                importTab.classList.toggle('active', tabId === 'import');
            }
        });
    });

    // Filter event listeners
    const searchInput = document.getElementById('project-existing-search-input');
    const showFilter = document.getElementById('project-show-filter');
    const categoryFilter = document.getElementById('project-category-filter');
    const sortSelect = document.getElementById('project-sort-select');
    const showCompleted = document.getElementById('project-show-completed');
    const showCurrent = document.getElementById('project-show-current');
    const showPdf = document.getElementById('project-show-pdf');
    const showMarkdown = document.getElementById('project-show-markdown');

    if (searchInput) searchInput.addEventListener('input', renderProjectExistingGrid);
    if (showFilter) showFilter.addEventListener('change', renderProjectExistingGrid);
    if (categoryFilter) categoryFilter.addEventListener('change', renderProjectExistingGrid);
    if (sortSelect) sortSelect.addEventListener('change', renderProjectExistingGrid);
    if (showCompleted) showCompleted.addEventListener('change', renderProjectExistingGrid);
    if (showCurrent) showCurrent.addEventListener('change', renderProjectExistingGrid);
    if (showPdf) showPdf.addEventListener('change', renderProjectExistingGrid);
    if (showMarkdown) showMarkdown.addEventListener('change', renderProjectExistingGrid);
}

// Populate project category filter dropdown
function populateProjectCategoryFilter() {
    const categoryFilter = document.getElementById('project-category-filter');
    if (!categoryFilter) return;

    const currentValue = categoryFilter.value;
    categoryFilter.innerHTML = '<option value="all">All Categories</option>';

    allCategories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        categoryFilter.appendChild(option);
    });

    categoryFilter.value = currentValue || 'all';
}

// Render existing patterns grid for project creation
function renderProjectExistingGrid() {
    const grid = document.getElementById('project-existing-grid');
    if (!grid) return;

    // Get filter values
    const searchQuery = (document.getElementById('project-existing-search-input')?.value || '').toLowerCase();
    const showFilter = document.getElementById('project-show-filter')?.value || 'all';
    const categoryFilter = document.getElementById('project-category-filter')?.value || 'all';
    const sortBy = document.getElementById('project-sort-select')?.value || 'date-desc';
    const showCompleted = document.getElementById('project-show-completed')?.checked !== false;
    const showCurrent = document.getElementById('project-show-current')?.checked !== false;
    const showPdf = document.getElementById('project-show-pdf')?.checked !== false;
    const showMarkdown = document.getElementById('project-show-markdown')?.checked !== false;

    // Filter patterns
    let filteredPatterns = patterns.filter(pattern => {
        // Search filter
        if (searchQuery) {
            const nameMatch = pattern.name.toLowerCase().includes(searchQuery);
            const descMatch = pattern.description?.toLowerCase().includes(searchQuery);
            const hashtagMatch = pattern.hashtags?.some(h => h.name.toLowerCase().includes(searchQuery.replace('#', '')));
            if (!nameMatch && !descMatch && !hashtagMatch) return false;
        }

        // Show filter
        if (showFilter === 'favorites' && !pattern.is_favorite) return false;
        if (showFilter === 'current' && !pattern.is_current) return false;
        if (showFilter === 'new' && (pattern.completed || pattern.timer_seconds > 0)) return false;

        // Category filter
        if (categoryFilter !== 'all' && pattern.category !== categoryFilter) return false;

        // Status filters
        if (!showCompleted && pattern.completed) return false;
        if (!showCurrent && pattern.is_current && !pattern.completed) return false;

        // Type filters
        const isPdf = pattern.pattern_type !== 'markdown';
        if (!showPdf && isPdf) return false;
        if (!showMarkdown && !isPdf) return false;

        return true;
    });

    // Sort patterns
    filteredPatterns.sort((a, b) => {
        switch (sortBy) {
            case 'date-asc':
                return new Date(a.upload_date) - new Date(b.upload_date);
            case 'opened-desc':
                return (new Date(b.last_opened_at || 0)) - (new Date(a.last_opened_at || 0));
            case 'opened-asc':
                return (new Date(a.last_opened_at || 0)) - (new Date(b.last_opened_at || 0));
            case 'name-asc':
                return a.name.localeCompare(b.name);
            case 'name-desc':
                return b.name.localeCompare(a.name);
            case 'date-desc':
            default:
                return new Date(b.upload_date) - new Date(a.upload_date);
        }
    });

    // Render grid
    if (filteredPatterns.length === 0) {
        grid.innerHTML = '<p class="project-empty-state">No patterns match your filters</p>';
    } else {
        grid.innerHTML = filteredPatterns.map(pattern => {
            const hashtags = pattern.hashtags || [];
            const hashtagsHtml = hashtags.length > 0
                ? `<div class="peg-hashtags">${hashtags.map(h => `<span class="peg-hashtag">#${escapeHtml(h.name)}</span>`).join('')}</div>`
                : '';

            const typeLabel = pattern.pattern_type === 'markdown' ? 'MD' : 'PDF';

            return `
                <div class="peg-card${projectSelectedPatternIds.includes(pattern.id) ? ' selected' : ''}"
                     data-pattern-id="${pattern.id}"
                     data-pattern-name="${escapeHtml(pattern.name.toLowerCase())}"
                     onclick="toggleProjectExistingPattern(${pattern.id})">
                    <div class="peg-thumb">
                        ${pattern.completed ? '<span class="peg-badge peg-complete"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                        ${!pattern.completed && pattern.is_current ? '<span class="peg-badge peg-current"><svg width="10" height="10" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span>' : ''}
                        ${pattern.category ? `<span class="peg-category">${escapeHtml(pattern.category)}</span>` : ''}
                        ${pattern.is_favorite ? '<span class="peg-favorite"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg></span>' : ''}
                        <span class="peg-type">${typeLabel}</span>
                        ${pattern.thumbnail
                            ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" alt="">`
                            : `<div class="pattern-thumbnail-placeholder">
                                   <img src="${API_URL}/icons/crocheting.svg" width="100" height="100" alt="">
                               </div>`
                        }
                    </div>
                    <div class="peg-info">
                        <div class="peg-name">${escapeHtml(pattern.name)}</div>
                        ${pattern.description ? `<div class="peg-desc">${escapeHtml(pattern.description)}</div>` : ''}
                        ${hashtagsHtml}
                    </div>
                </div>
            `;
        }).join('');
    }

    updateProjectSelectedCount();
}

// Toggle existing pattern selection
function toggleProjectExistingPattern(patternId) {
    const item = document.querySelector(`.peg-card[data-pattern-id="${patternId}"]`);
    const isSelected = projectSelectedPatternIds.includes(patternId);

    if (isSelected) {
        projectSelectedPatternIds = projectSelectedPatternIds.filter(id => id !== patternId);
        if (item) item.classList.remove('selected');
    } else {
        projectSelectedPatternIds.push(patternId);
        if (item) item.classList.add('selected');
    }
    updateProjectSelectedCount();
}

// Update selected count display
function updateProjectSelectedCount() {
    const countEl = document.getElementById('project-selected-count');
    const countText = document.getElementById('project-selected-count-text');

    if (countEl && countText) {
        const count = projectSelectedPatternIds.length;
        countEl.style.display = count > 0 ? 'block' : 'none';
        countText.textContent = `${count} pattern${count !== 1 ? 's' : ''} selected`;
    }
}

function formatTimeHumanReadable(seconds) {
    if (!seconds || seconds === 0) return '0h 0m';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

// ============================================

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function userColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = ((hash % 360) + 360) % 360;
    return `hsl(${hue}, 65%, 45%)`;
}

// ============================================
// INVENTORY (Yarn & Hooks)
// ============================================

// --- Hook/Needle craft type data ---

const CROCHET_SIZES = [
    { value: '2.0|B/1', label: '2.0mm - B/1' },
    { value: '2.25|B/1', label: '2.25mm - B/1' },
    { value: '2.75|C/2', label: '2.75mm - C/2' },
    { value: '3.25|D/3', label: '3.25mm - D/3' },
    { value: '3.5|E/4', label: '3.5mm - E/4' },
    { value: '3.75|F/5', label: '3.75mm - F/5' },
    { value: '4.0|G/6', label: '4.0mm - G/6' },
    { value: '4.5|7', label: '4.5mm - 7' },
    { value: '5.0|H/8', label: '5.0mm - H/8' },
    { value: '5.5|I/9', label: '5.5mm - I/9' },
    { value: '6.0|J/10', label: '6.0mm - J/10' },
    { value: '6.5|K/10.5', label: '6.5mm - K/10.5' },
    { value: '8.0|L/11', label: '8.0mm - L/11' },
    { value: '9.0|M/13', label: '9.0mm - M/13' },
    { value: '10.0|N/15', label: '10.0mm - N/15' },
    { value: '11.5|P/16', label: '11.5mm - P/16' },
    { value: '15.0|P/Q', label: '15.0mm - P/Q' },
    { value: '19.0|S', label: '19.0mm - S' },
];

const KNITTING_SIZES = [
    { value: '2.0|US 0', label: '2.0mm - US 0 / UK 14' },
    { value: '2.25|US 1', label: '2.25mm - US 1 / UK 13' },
    { value: '2.5|US 1.5', label: '2.5mm - US 1.5' },
    { value: '2.75|US 2', label: '2.75mm - US 2 / UK 12' },
    { value: '3.0|US 2.5', label: '3.0mm - US 2.5 / UK 11' },
    { value: '3.25|US 3', label: '3.25mm - US 3 / UK 10' },
    { value: '3.5|US 4', label: '3.5mm - US 4' },
    { value: '3.75|US 5', label: '3.75mm - US 5 / UK 9' },
    { value: '4.0|US 6', label: '4.0mm - US 6 / UK 8' },
    { value: '4.5|US 7', label: '4.5mm - US 7 / UK 7' },
    { value: '5.0|US 8', label: '5.0mm - US 8 / UK 6' },
    { value: '5.5|US 9', label: '5.5mm - US 9 / UK 5' },
    { value: '6.0|US 10', label: '6.0mm - US 10 / UK 4' },
    { value: '6.5|US 10.5', label: '6.5mm - US 10.5 / UK 3' },
    { value: '8.0|US 11', label: '8.0mm - US 11 / UK 0' },
    { value: '9.0|US 13', label: '9.0mm - US 13 / UK 00' },
    { value: '10.0|US 15', label: '10.0mm - US 15' },
    { value: '12.75|US 17', label: '12.75mm - US 17' },
    { value: '15.0|US 19', label: '15.0mm - US 19' },
    { value: '19.0|US 35', label: '19.0mm - US 35' },
    { value: '25.0|US 50', label: '25.0mm - US 50' },
];

const CROCHET_TYPES = [
    { value: 'Inline', label: 'Inline (Bates)' },
    { value: 'Tapered', label: 'Tapered (Boye)' },
    { value: 'Ergonomic', label: 'Ergonomic' },
    { value: 'Tunisian', label: 'Tunisian' },
];

const KNITTING_TYPES = [
    { value: 'Straight', label: 'Straight' },
    { value: 'Circular', label: 'Circular' },
    { value: 'DPN', label: 'Double-Pointed (DPN)' },
    { value: 'Interchangeable', label: 'Interchangeable' },
];

const NEEDLE_LENGTHS = {
    Straight: ['9"', '10"', '12"', '14"'],
    Circular: ['9"', '12"', '16"', '20"', '24"', '29"', '32"', '36"', '40"', '47"', '60"'],
    DPN: ['5"', '6"', '7"', '8"'],
    Interchangeable: ['4" tip', '5" tip'],
};

let currentCraftType = 'crochet';

function setCraftType(type) {
    currentCraftType = type;
    document.querySelectorAll('.craft-type-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.craft === type);
    });

    const sizeSelect = document.getElementById('hook-size');
    const typeSelect = document.getElementById('hook-type');
    const sizes = type === 'knitting' ? KNITTING_SIZES : CROCHET_SIZES;
    const types = type === 'knitting' ? KNITTING_TYPES : CROCHET_TYPES;

    sizeSelect.innerHTML = '<option value="">Select...</option>' +
        sizes.map(s => `<option value="${s.value}">${s.label}</option>`).join('');

    typeSelect.innerHTML = '<option value="">Select...</option>' +
        types.map(t => `<option value="${t.value}">${t.label}</option>`).join('');

    // Show/hide length field
    const lengthRow = document.getElementById('hook-length-row');
    if (type === 'knitting') {
        lengthRow.style.display = '';
        updateLengthOptions();
    } else {
        lengthRow.style.display = 'none';
    }
}

function updateLengthOptions() {
    const needleType = document.getElementById('hook-type').value;
    const lengthSelect = document.getElementById('hook-length');
    const lengths = NEEDLE_LENGTHS[needleType] || [];
    if (lengths.length === 0) {
        lengthSelect.innerHTML = '<option value="">Select type first</option>';
        lengthSelect.disabled = true;
    } else {
        lengthSelect.disabled = false;
        lengthSelect.innerHTML = '<option value="">Select...</option>' +
            lengths.map(l => `<option value="${l}">${l}</option>`).join('');
    }
}

function initInventory() {
    // Edit modal tabs (Details / Inventory)
    initEditModalTabs();

    // Sub-tab switching
    const invMobileSearch = document.getElementById('inv-mobile-search-input');
    const invMobileSearchClear = document.getElementById('inv-mobile-search-clear-btn');
    const invDesktopSearch = document.getElementById('inventory-search');

    document.querySelectorAll('.inventory-sub-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.inventory-sub-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.inventory-sub-content').forEach(c => c.style.display = 'none');
            btn.classList.add('active');
            document.getElementById(`inventory-${btn.dataset.sub}`).style.display = '';
            inventorySubTab = btn.dataset.sub;
            localStorage.setItem('inventorySubTab', inventorySubTab);
            // Toggle add buttons
            document.getElementById('add-yarn-btn').style.display = btn.dataset.sub === 'yarn' ? '' : 'none';
            document.getElementById('add-hook-btn').style.display = btn.dataset.sub === 'hooks' ? '' : 'none';
            const mobileAddBtn = document.getElementById('inv-mobile-add-btn');
            if (mobileAddBtn) mobileAddBtn.textContent = btn.dataset.sub === 'yarn' ? '+ Add Yarn' : '+ Add Item';
            // Update search placeholder
            const placeholder = btn.dataset.sub === 'yarn' ? 'Search yarn...' : 'Search hooks...';
            if (invDesktopSearch) { invDesktopSearch.placeholder = placeholder; invDesktopSearch.value = ''; }
            if (invMobileSearch) { invMobileSearch.placeholder = placeholder; invMobileSearch.value = ''; }
            // Close mobile sidebar on tab switch
            document.querySelectorAll('.inventory-sidebar').forEach(s => s.classList.remove('mobile-visible'));
            const invMobileFilterBtn = document.getElementById('inv-mobile-filter-btn');
            if (invMobileFilterBtn) invMobileFilterBtn.classList.remove('active');
            clearInventorySelection();
        });
    });

    // Mobile filter toggle
    const invMobileFilterBtn = document.getElementById('inv-mobile-filter-btn');
    if (invMobileFilterBtn) {
        invMobileFilterBtn.addEventListener('click', () => {
            const activeSidebar = document.getElementById(inventorySubTab === 'yarn' ? 'yarn-sidebar' : 'hooks-sidebar');
            if (activeSidebar) {
                // Clear any inline display style (set by list-view init) so CSS classes work
                activeSidebar.style.display = '';
                activeSidebar.classList.toggle('mobile-visible');
                invMobileFilterBtn.classList.toggle('active', activeSidebar.classList.contains('mobile-visible'));
            }
        });
    }

    // Mobile search sync
    if (invMobileSearch) {
        invMobileSearch.addEventListener('input', (e) => {
            if (invDesktopSearch) invDesktopSearch.value = e.target.value;
            if (invMobileSearchClear) invMobileSearchClear.classList.toggle('visible', e.target.value.length > 0);
            if (inventorySubTab === 'yarn') displayYarns();
            else displayHooks();
        });
    }
    if (invMobileSearchClear) {
        invMobileSearchClear.addEventListener('click', () => {
            if (invMobileSearch) invMobileSearch.value = '';
            if (invDesktopSearch) invDesktopSearch.value = '';
            invMobileSearchClear.classList.remove('visible');
            if (inventorySubTab === 'yarn') displayYarns();
            else displayHooks();
        });
    }

    // Mobile add button
    const invMobileAddBtn = document.getElementById('inv-mobile-add-btn');
    if (invMobileAddBtn) {
        invMobileAddBtn.addEventListener('click', () => {
            if (inventorySubTab === 'yarn') openYarnModal();
            else openHookModal();
        });
    }

    // View toggle (card / list)
    document.querySelectorAll('#inventory-view-toggle .view-toggle-btn, #inv-mobile-view-toggle .view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            inventoryView = btn.dataset.view;
            localStorage.setItem('inventoryView', inventoryView);
            document.querySelectorAll('#inventory-view-toggle .view-toggle-btn, #inv-mobile-view-toggle .view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === inventoryView));
            // Hide filter button in list view (no sidebar filters)
            const fb = document.getElementById('inv-mobile-filter-btn');
            const dfb = document.getElementById('inventory-filter-btn');
            if (fb) fb.style.display = inventoryView === 'list' ? 'none' : '';
            if (dfb) dfb.style.display = inventoryView === 'list' ? 'none' : '';
            clearInventorySelection();
            exitInventoryEditMode();
            displayYarns();
            displayHooks();
        });
    });

    // Set initial filter button visibility
    const initFb = document.getElementById('inv-mobile-filter-btn');
    const initDfb = document.getElementById('inventory-filter-btn');
    if (initFb) initFb.style.display = inventoryView === 'list' ? 'none' : '';
    if (initDfb) initDfb.style.display = inventoryView === 'list' ? 'none' : '';

    // Add buttons
    document.getElementById('add-yarn-btn')?.addEventListener('click', () => openYarnModal());
    document.getElementById('add-hook-btn')?.addEventListener('click', () => openHookModal());

    // Yarn modal
    document.getElementById('yarn-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveYarn(); });
    document.getElementById('cancel-yarn-btn')?.addEventListener('click', () => closeYarnModal());
    document.getElementById('close-yarn-modal')?.addEventListener('click', () => closeYarnModal());
    document.getElementById('yarn-modal')?.addEventListener('click', (e) => { if (e.target.id === 'yarn-modal') closeYarnModal(); });
    document.getElementById('delete-yarn-btn')?.addEventListener('click', () => { if (editingYarnId) deleteYarn(editingYarnId); });
    document.getElementById('duplicate-yarn-btn')?.addEventListener('click', () => { if (editingYarnId) { closeYarnModal(); duplicateYarn(editingYarnId); } });
    document.getElementById('yarn-import-img-btn')?.addEventListener('click', () => importImageFromUrl('yarn'));
    document.getElementById('yarn-favorite-btn')?.addEventListener('click', () => {
        const btn = document.getElementById('yarn-favorite-btn');
        btn.classList.toggle('active');
    });
    // Hook modal
    document.getElementById('hook-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveHook(); });
    document.getElementById('cancel-hook-btn')?.addEventListener('click', () => closeHookModal());
    document.getElementById('close-hook-modal')?.addEventListener('click', () => closeHookModal());
    document.getElementById('hook-modal')?.addEventListener('click', (e) => { if (e.target.id === 'hook-modal') closeHookModal(); });
    document.getElementById('delete-hook-btn')?.addEventListener('click', () => { if (editingHookId) deleteHook(editingHookId); });
    document.getElementById('duplicate-hook-btn')?.addEventListener('click', () => { if (editingHookId) { closeHookModal(); duplicateHook(editingHookId); } });
    document.getElementById('hook-import-img-btn')?.addEventListener('click', () => importImageFromUrl('hook'));

    // Craft type toggle
    document.querySelectorAll('.craft-type-btn').forEach(btn => {
        btn.addEventListener('click', () => setCraftType(btn.dataset.craft));
    });

    // Update length options when needle type changes
    document.getElementById('hook-type')?.addEventListener('change', () => {
        if (currentCraftType === 'knitting') updateLengthOptions();
    });

    // Sidebar toggle buttons
    document.querySelectorAll('.inv-sidebar-toggle').forEach(btn => {
        const sidebarId = btn.dataset.sidebar;
        const sidebar = document.getElementById(sidebarId);
        if (!sidebar) return;
        const key = sidebarId + 'Collapsed';
        if (localStorage.getItem(key) === 'true') {
            sidebar.style.display = 'none';
            btn.classList.add('active');
        }
        btn.addEventListener('click', () => {
            const isHidden = sidebar.style.display === 'none';
            sidebar.style.display = isHidden ? '' : 'none';
            btn.classList.toggle('active', !isHidden);
            localStorage.setItem(key, !isHidden);
        });
    });

    // Brand autocomplete
    initBrandAutocomplete('yarn-brand', 'yarn-brand-list', DEFAULT_YARN_BRANDS);
    initBrandAutocomplete('hook-brand', 'hook-brand-list', DEFAULT_HOOK_BRANDS);

    // Quantity stepper buttons
    document.querySelectorAll('.qty-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            const step = parseFloat(btn.dataset.step) || 1;
            const dir = parseInt(btn.dataset.dir);
            const min = parseFloat(input.min) || 0;
            let val = parseFloat(input.value) || 0;
            val = Math.round((val + step * dir) * 10) / 10;
            if (val < min) val = min;
            input.value = val;
        });
    });

    // Search (desktop → mobile sync)
    document.getElementById('inventory-search')?.addEventListener('input', (e) => {
        if (invMobileSearch) invMobileSearch.value = e.target.value;
        if (invMobileSearchClear) invMobileSearchClear.classList.toggle('visible', e.target.value.length > 0);
        if (inventorySubTab === 'yarn') displayYarns();
        else displayHooks();
    });

    // Sidebar sort/filter
    document.getElementById('yarn-sort-select')?.addEventListener('change', () => displayYarns());
    document.getElementById('yarn-weight-filter')?.addEventListener('change', () => displayYarns());
    document.getElementById('yarn-brand-filter')?.addEventListener('change', () => displayYarns());
    document.getElementById('yarn-rating-filter')?.addEventListener('change', () => displayYarns());
    document.getElementById('hook-sort-select')?.addEventListener('change', () => displayHooks());
    document.getElementById('hook-craft-filter')?.addEventListener('change', () => displayHooks());
    document.getElementById('hook-type-filter')?.addEventListener('change', () => displayHooks());
    document.getElementById('hook-brand-filter')?.addEventListener('change', () => displayHooks());
    document.getElementById('hook-rating-filter')?.addEventListener('change', () => displayHooks());
}

// --- Inventory column config ---

const LIST_YARN_PLACEHOLDER = '<div class="list-thumbnail-placeholder"><svg viewBox="5 18 90 67" fill="currentColor"><path d="M47.6,34.1c-1.4,1-2.7,2.1-4.1,3.3c5.1,4.4,12.8,15.9,13.9,29c1.8-2.1,3.2-4.6,4.3-7.2C59.6,46.6,51.3,36.3,47.6,34.1z"/><path d="M45.2,60.8c-6.4,4.9-14,8.3-21,9.4v0c-0.2,1-0.3,2-0.4,2.9c1.2,0.6,2.4,1.1,3.6,1.6c8.2-1,15.4-5.1,19.3-7.8C46.4,64.8,45.8,62.7,45.2,60.8z"/><path d="M34.6,47.6c-2.6,3.4-4.6,6.9-6.2,10.2c4.3-1.7,8.6-4.2,12.2-7.1c-1.4-2.3-2.8-4.2-4-5.7C35.9,45.8,35.2,46.7,34.6,47.6z"/><path d="M44.8,23.1c-2.7-0.9-5.7-1.4-8.7-1.3c-4.9,3.3-9.5,8-14.3,14.4c-6.4,8.5-9.4,17.1-10.5,23.3c0.9,2.2,2.1,4.3,3.6,6.1c1-6.7,4.2-16,11.1-25.2C32.3,32.1,38.3,26.5,44.8,23.1z"/><path d="M53.3,27.6c-1.5-1.2-3.2-2.3-5-3.1c-7,3-13.4,8.6-20.1,17.5c-7.5,10-10.4,20.2-10.9,26.4c1.2,1.2,2.5,2.2,3.9,3.2c0.9-6.7,4.1-16.3,11.2-25.7C39.3,36.7,46,30.9,53.3,27.6z"/><path d="M63.3,53.9c0.4-2.1,0.5-4.4,0.4-6.6c-0.5-6.9-3.5-13.1-8.1-17.6c-1.9,0.7-3.8,1.7-5.6,2.8C54.1,35.6,60.3,43.7,63.3,53.9z"/><path d="M30.8,22.4C17.8,25.2,8.4,37.2,9.3,50.9c0.1,1.1,0.2,2.2,0.4,3.3c1.7-5.8,4.7-12.8,9.9-19.6C23.4,29.6,27.1,25.5,30.8,22.4z"/><path d="M33.9,76.2c1.4,0.1,2.9,0.2,4.4,0.1c3.1-0.2,6-0.9,8.8-2.1c0.1-1.4,0.1-2.8,0-4.2C43.9,72,39.3,74.6,33.9,76.2z"/><path d="M24.8,67.3c6.5-1.2,13.5-4.5,19.4-9.2l0,0c-0.7-1.8-1.5-3.5-2.3-5c-4.5,3.5-9.9,6.4-15.1,8.1C26,63.4,25.3,65.4,24.8,67.3z"/><path d="M91.6,80c-4.1-7.4-7.4-10.9-14.6-10.6c-2.8,0.1-5.4,1.8-8.2,3.7c-4,2.6-7.8,5.1-11.7,3c-1-0.6-1.7-1.5-2.2-2.4c-0.9,0.7-1.8,1.3-2.8,1.9c0.7,1.3,1.8,2.6,3.4,3.5c5.7,3.1,10.9-0.4,15.2-3.1c2.4-1.6,4.7-3.1,6.5-3.1c5.5-0.2,7.7,2.1,11.6,8.9c0.4,0.8,1.5,1.1,2.3,0.6C91.7,81.8,92,80.8,91.6,80z"/><path d="M50.1,72.7c0.4-0.2,0.4-0.3,0.8-0.5c0,0,0,0,0,0c0,0,0,0.1,0,0.1c1-0.7,2.1-1.4,3.1-2.3c0,0,0-0.1,0-0.1c0.3-0.2,0.6-0.5,0.9-0.7c-0.2-12.9-8-25.4-13.3-29.8c-1.1,1.1-2.1,2.2-3.2,3.5c5.5,6.3,10.7,16.6,11.4,27.1C49.8,70.9,50.1,71.7,50.1,72.7z"/></svg></div>';
const CROCHET_HOOK_SVG = '<path d="M93.7,82L52,40.3l-4-4.1l-1.4-1.4l0,0l-4.5-4.5C41.3,29.5,40.2,29,39,29c-0.8,0-1.6,0.2-2.5,0.5l-5.1-5.1l-0.2-0.2l-4.8-4.8l-5.2-5.2C19.3,12.4,13,6.3,9,5.9c-0.1,0-0.2,0-0.4,0l0,0c-1.3,0-2.1,0.5-2.5,1c-1,1-1.2,2.5-1,4.1c0.1,0.5,0.2,1.1,0.4,1.6c0.1,0.3,0.2,0.6,0.3,0.8c0.6,1.4,1.4,2.7,2.3,3.9c0.4,0.5,0.7,0.9,1.1,1.3l0,0l0,0l0.1,0.1c0.3,0.3,1,0.7,1.9,0.7l0,0l0,0c0.7,0,1.4-0.3,1.9-0.8c0.1-0.1,0.3-0.3,0.4-0.4c0.1,0.1,0.1,0.2,0.2,0.2c0.1,0.2,0.3,0.4,0.5,0.6c0.2,0.3,0.4,0.5,0.6,0.7c0.1,0.2,0.3,0.3,0.4,0.5l4.7,4.7l4.7,4.7l5.9,5.9c-0.9,2.2-0.6,4.2,0.7,5.6l1.4,1.4l4.6,4.6l1.4,1.4l0,0l24.9,24.9l19.3,19.3c0.8,0.8,1.9,1.3,3.1,1.3c2.6,0,5-2,6.2-3.2C95.2,87.9,95.9,84.1,93.7,82z M14.4,15.7c-0.1-0.2-0.2-0.3-0.3-0.5c-0.3-0.5-0.5-0.9-0.5-0.9s-0.5-0.8-1-0.8c-0.2,0-0.3,0.1-0.5,0.2c-0.3,0.3-0.2,1-0.1,1.6c0,0.4,0.1,0.7,0.1,1.1c0,0.3-0.1,0.6-0.3,0.8c-0.1,0.1-0.2,0.1-0.3,0.2c-0.1,0-0.2,0-0.3,0s-0.2,0-0.3,0c-0.2-0.1-0.3-0.1-0.4-0.2h-0.1c-0.4-0.4-0.7-0.7-1-1.1s-0.6-0.8-0.9-1.3c-0.4-0.6-0.7-1.2-0.9-1.7c-0.1-0.2-0.1-0.3-0.2-0.5C6.9,10.7,6.8,9,7.5,8.3C7.8,8,8.2,7.9,8.6,7.9c0.1,0,0.1,0,0.2,0c3.6,0.3,10.9,7.8,10.9,7.8c4.1,4.1,6.4,6.4,7.8,7.8c0.9,0.9,1.4,1.4,1.7,1.7c0.1,0.1,0.1,0.1,0.2,0.2s0.1,0.1,0.2,0.2c0,0,0,0,0.1,0.1c0,0,0.1,0.1,0.2,0.2c0.6,0.6,1.5,1.5,7.6,7.6c0.5,0.5,0.2,1.6-0.6,2.4c-0.6,0.6-1.3,1-1.9,1c-0.3,0-0.5-0.1-0.7-0.3c-0.5-0.5-1-1-1.4-1.4c-1.6-1.6-2.9-2.9-3.8-3.8c-2-2-2.6-2.6-3-3c-0.1-0.1-0.1-0.1-0.2-0.2c-0.3-0.3-0.6-0.6-2.4-2.4c-0.7-0.7-1.8-1.8-3.2-3.2c-0.7-0.7-1.5-1.5-2.4-2.4c-0.5-0.5-0.9-0.9-1.4-1.4c-0.3-0.3-0.6-0.6-0.8-1c-0.2-0.2-0.4-0.5-0.5-0.7c-0.2-0.3-0.3-0.5-0.5-0.8C14.6,16.2,14.5,15.9,14.4,15.7z M90.9,89.5c-1.5,1.5-3.3,2.6-4.8,2.6c-0.7,0-1.2-0.2-1.7-0.7C64.3,71.4,51.9,59,38.7,45.8l0,0c-1.7-1.7-4.2-4.2-6-6c-0.7-0.7-0.8-1.6-0.6-2.6l0.8,0.8c0.6,0.6,1.3,0.9,2.1,0.9c1.5,0,2.7-1,3.3-1.6s1.1-1.4,1.3-2.1c0.3-1.2,0.1-2.3-0.7-3.1l-0.8-0.8c0.3-0.1,0.6-0.1,0.9-0.1c0.6,0,1.2,0.2,1.7,0.7c1.2,1.2,4.5,4.5,5.9,5.9l0,0c13.5,13.5,25,25,45.8,45.8C93.7,84.8,92.8,87.6,90.9,89.5z"/>';
const KNITTING_NEEDLE_SVG = '<path d="M81.6667 90.6186l-26.8986 49.0622c-0.2835,0.5172 -0.4985,1.022 -0.6522,1.5101 -3.8458,-0.3929 -7.736,1.5522 -9.7939,5.3057 -2.8078,5.1214 -1.1415,11.6701 3.7218,14.6269 4.8633,2.9569 11.0821,1.2021 13.8899,-3.9192 2.0579,-3.7536 1.7123,-8.2738 -0.5335,-11.5848 0.3245,-0.3841 0.6322,-0.8326 0.9157,-1.3498l24.3828 -44.473 5.0318 -9.1779 28.7265 -52.3961 9.9823 -27.3854 -17.5302 22.7964 -26.2105 47.807 -5.0319 9.1779z"/><path d="M118.629 139.681l-25.3537 -46.2443 -5.0318 9.1779 22.8378 41.6554c0.2835,0.5172 0.5911,0.9657 0.9155,1.3501 -2.2458,3.3109 -2.5912,7.8309 -0.5333,11.5844 2.8078,5.1213 9.0266,6.8761 13.8899,3.9193 4.8633,-2.9568 6.5296,-9.5056 3.7218,-14.627 -2.0579,-3.7535 -5.9479,-5.6984 -9.7936,-5.3058 -0.1539,-0.488 -0.369,-0.9928 -0.6526,-1.51z"/><polygon points="85.1537,78.6229 60.488,33.6337 42.9579,10.8373 52.9403,38.2227 80.1218,87.8008 84.3229,80.1382 "/>';
function hookPlaceholderSvg(craftType, size) {
    const isKnitting = craftType === 'knitting';
    const vb = isKnitting ? '0 0 173.397 173.397' : '0 0 100 125';
    const path = isKnitting ? KNITTING_NEEDLE_SVG : CROCHET_HOOK_SVG;
    return `<svg width="${size}" height="${size}" viewBox="${vb}" fill="currentColor">${path}</svg>`;
}
const LIST_HOOK_PLACEHOLDER = '<div class="list-thumbnail-placeholder"><svg width="26" height="26" viewBox="0 0 100 125" fill="currentColor">' + CROCHET_HOOK_SVG + '</svg></div>';
const LIST_PATTERN_PLACEHOLDER = '<div class="list-thumbnail-placeholder"><img src="' + API_URL + '/icons/crocheting.svg" width="30" height="30" alt=""></div>';

const STAR_SVG = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>';
function ratingStarsHtml(rating, size = 14) {
    if (!rating) return '—';
    let html = '';
    for (let i = 1; i <= 5; i++) {
        html += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${i <= rating ? '#eab308' : 'none'}" stroke="${i <= rating ? '#eab308' : '#666'}" stroke-width="2" style="vertical-align:middle">${STAR_SVG}</svg>`;
    }
    return `<span style="white-space:nowrap">${html}</span>`;
}
function ratingBadgeHtml(rating, size = 16) {
    let html = '';
    for (let i = 0; i < rating; i++) {
        html += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" stroke-width="2" style="vertical-align:middle;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))">${STAR_SVG}</svg>`;
    }
    return html;
}
function ratingInputHtml(id, rating = 0) {
    let html = `<div class="star-rating-input" data-rating="${rating}" id="${id}">`;
    for (let i = 1; i <= 5; i++) {
        html += `<svg width="22" height="22" viewBox="0 0 24 24" fill="${i <= rating ? '#eab308' : 'none'}" stroke="${i <= rating ? '#eab308' : '#666'}" stroke-width="2" style="cursor:pointer" data-value="${i}" onclick="setStarRating('${id}', ${i})">${STAR_SVG}</svg>`;
    }
    if (rating > 0) html += `<span class="star-rating-clear" onclick="setStarRating('${id}', 0)" title="Clear rating">&times;</span>`;
    html += '</div>';
    return html;
}
function setStarRating(containerId, value) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.dataset.rating = value;
    const stars = container.querySelectorAll('svg');
    stars.forEach((svg, i) => {
        const filled = (i + 1) <= value;
        svg.setAttribute('fill', filled ? '#eab308' : 'none');
        svg.setAttribute('stroke', filled ? '#eab308' : '#666');
    });
    // Update clear button
    const existing = container.querySelector('.star-rating-clear');
    if (value > 0 && !existing) {
        const clear = document.createElement('span');
        clear.className = 'star-rating-clear';
        clear.title = 'Clear rating';
        clear.textContent = '\u00d7';
        clear.onclick = () => setStarRating(containerId, 0);
        container.appendChild(clear);
    } else if (value === 0 && existing) {
        existing.remove();
    }
}

const YARN_COLUMNS = {
    thumbnail: { label: 'Photo', value: y => y.thumbnail ? `<img src="${API_URL}/api/yarns/${y.id}/thumbnail" class="list-thumbnail" alt="">` : LIST_YARN_PLACEHOLDER },
    brand: { label: 'Brand', value: y => escapeHtml(y.brand || '—') },
    name: { label: 'Name', value: y => escapeHtml(y.name || '—') },
    color: { label: 'Color', value: y => escapeHtml(y.color || '—') },
    dye_lot: { label: 'Dye Lot', value: y => escapeHtml(y.dye_lot || '—') },
    weight_category: { label: 'Weight', value: y => escapeHtml(y.weight_category || '—') },
    quantity: { label: 'Qty', value: y => parseFloat(y.quantity) || 0 },
    fiber_content: { label: 'Fiber', value: y => escapeHtml(y.fiber_content || '—') },
    pattern_count: { label: 'Patterns', value: y => y.pattern_count || 0 },
    notes: { label: 'Notes', value: y => y.notes ? escapeHtml(y.notes.substring(0, 50)) + (y.notes.length > 50 ? '...' : '') : '—' },
    favorite: { label: 'Fav', value: y => y.is_favorite ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="color:#f87171"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>' : '—' },
    rating: { label: 'Rating', value: y => ratingStarsHtml(y.rating) },
    yardage: { label: 'Yardage', value: y => y.yardage ? parseFloat(y.yardage) + ' yds' : '—' },
    unit_weight: { label: 'Unit Wt', value: y => y.unit_weight ? parseFloat(y.unit_weight) + 'g' : '—' },
    gauge: { label: 'Gauge', value: y => escapeHtml(y.gauge || '—') },
    needle_size: { label: 'Needle', value: y => escapeHtml(y.needle_size || '—') },
    hook_size: { label: 'Hook', value: y => escapeHtml(y.hook_size || '—') },
    url: { label: 'URL', value: y => y.url ? `<a href="${escapeHtml(y.url)}" target="_blank" onclick="event.stopPropagation()" class="list-url-link">Link</a>` : '—' },
    created_at: { label: 'Added', value: y => y.created_at ? new Date(y.created_at).toLocaleDateString() : '—' },
};
const DEFAULT_YARN_COL_ORDER = ['thumbnail', 'brand', 'name', 'color', 'dye_lot', 'weight_category', 'quantity', 'fiber_content', 'yardage', 'unit_weight', 'gauge', 'needle_size', 'hook_size', 'favorite', 'rating', 'pattern_count', 'notes', 'created_at'];

const HOOK_COLUMNS = {
    thumbnail: { label: 'Photo', value: h => h.thumbnail ? `<img src="${API_URL}/api/hooks/${h.id}/thumbnail" class="list-thumbnail" alt="">` : `<div class="list-thumbnail-placeholder">${hookPlaceholderSvg(h.craft_type, 26)}</div>` },
    brand: { label: 'Brand', value: h => escapeHtml(h.brand || '—') },
    name: { label: 'Name', value: h => escapeHtml(h.name || '—') },
    size_label: { label: 'Size', value: h => escapeHtml(h.size_label || '—') },
    size_mm: { label: 'Size (mm)', value: h => h.size_mm ? h.size_mm + 'mm' : '—' },
    hook_type: { label: 'Type', value: h => escapeHtml(h.hook_type || '—') },
    craft_type: { label: 'Craft', value: h => escapeHtml(h.craft_type || '—') },
    length: { label: 'Length', value: h => escapeHtml(h.length || '—') },
    quantity: { label: 'Qty', value: h => h.quantity || 0 },
    pattern_count: { label: 'Patterns', value: h => h.pattern_count || 0 },
    notes: { label: 'Notes', value: h => h.notes ? escapeHtml(h.notes.substring(0, 50)) + (h.notes.length > 50 ? '...' : '') : '—' },
    favorite: { label: 'Fav', value: h => h.is_favorite ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="color:#f87171"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>' : '—' },
    rating: { label: 'Rating', value: h => ratingStarsHtml(h.rating) },
    url: { label: 'URL', value: h => h.url ? `<a href="${escapeHtml(h.url)}" target="_blank" onclick="event.stopPropagation()" class="list-url-link">Link</a>` : '—' },
    created_at: { label: 'Added', value: h => h.created_at ? new Date(h.created_at).toLocaleDateString() : '—' },
};
const DEFAULT_HOOK_COL_ORDER = ['thumbnail', 'brand', 'name', 'size_label', 'size_mm', 'hook_type', 'craft_type', 'length', 'quantity', 'favorite', 'rating', 'pattern_count', 'notes', 'created_at'];

const PATTERN_COLUMNS = {
    thumbnail: { label: 'Photo', value: p => p.thumbnail ? `<img src="${API_URL}/api/patterns/${p.id}/thumbnail" class="list-thumbnail" alt="">` : LIST_PATTERN_PLACEHOLDER },
    name:     { label: 'Name',     value: p => escapeHtml(p.name || '—') },
    category: { label: 'Category', value: p => escapeHtml(p.category || '—') },
    tags:     { label: 'Tags',     value: p => (p.hashtags && p.hashtags.length > 0) ? p.hashtags.map(h => `<span class="list-tag" onclick="event.stopPropagation();filterByHashtag('${escapeHtml(h.name)}')" style="cursor:pointer">#${escapeHtml(h.name)}</span>`).join(' ') : '—' },
    type:     { label: 'Type',     value: p => p.pattern_type === 'markdown' ? 'MD' : 'PDF' },
    status:   { label: 'Status',   value: p => p.completed ? 'Completed' : (p.is_current ? 'In Progress' : 'New') },
    added:    { label: 'Added',    value: p => p.upload_date ? new Date(p.upload_date).toLocaleDateString() : '—' },
    opened:   { label: 'Opened',   value: p => p.last_opened_at ? new Date(p.last_opened_at).toLocaleDateString() : '—' },
    time:     { label: 'Time',     value: p => p.timer_seconds > 0 ? formatTime(p.timer_seconds) : '—' },
    description: { label: 'Description', value: p => p.description ? escapeHtml(p.description.substring(0, 50)) + (p.description.length > 50 ? '...' : '') : '—' },
    favorite: { label: 'Favorite', value: p => p.is_favorite ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color:#f87171"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>' : '—' },
    rating: { label: 'Rating', value: p => ratingStarsHtml(p.rating) },
    completed_date: { label: 'Completed', value: p => p.completed_date ? new Date(p.completed_date).toLocaleDateString() : '—' },
    started_date: { label: 'Started', value: p => p.started_date ? new Date(p.started_date).toLocaleDateString() : '—' },
};
const DEFAULT_PATTERN_COL_ORDER = ['thumbnail', 'name', 'category', 'tags', 'type', 'status', 'added', 'opened', 'time', 'description', 'favorite', 'rating', 'completed_date', 'started_date'];

function getColumnsConfig(type) {
    return type === 'pattern' ? PATTERN_COLUMNS : (type === 'yarn' ? YARN_COLUMNS : HOOK_COLUMNS);
}

function getHiddenColumns(type) {
    try {
        const key = type === 'pattern' ? 'patternHiddenColumns' : (type === 'yarn' ? 'yarnHiddenColumns' : 'hookHiddenColumns');
        const saved = localStorage.getItem(key);
        if (!saved) return {};
        const parsed = JSON.parse(saved);
        // Migrate old array format to object format
        if (Array.isArray(parsed)) {
            const obj = {};
            for (const c of parsed) obj[c] = null;
            return obj;
        }
        return parsed;
    } catch (e) { return {}; }
}

function saveHiddenColumns(type, hidden) {
    const key = type === 'pattern' ? 'patternHiddenColumns' : (type === 'yarn' ? 'yarnHiddenColumns' : 'hookHiddenColumns');
    localStorage.setItem(key, JSON.stringify(hidden));
    syncSettingsToServer();
}

function getColumnOrder(type) {
    const key = type === 'pattern' ? 'patternColumnOrder' : (type === 'yarn' ? 'yarnColumnOrder' : 'hookColumnOrder');
    const defaults = type === 'pattern' ? DEFAULT_PATTERN_COL_ORDER : (type === 'yarn' ? DEFAULT_YARN_COL_ORDER : DEFAULT_HOOK_COL_ORDER);
    const allCols = getColumnsConfig(type);
    const hidden = getHiddenColumns(type);
    try {
        const saved = localStorage.getItem(key);
        if (saved) {
            const order = JSON.parse(saved);
            if (Array.isArray(order) && order.length > 0 && order.every(c => c in allCols)) {
                // Deduplicate (preserves first occurrence)
                const seen = new Set();
                const deduped = order.filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
                // Auto-add only truly new columns (not in saved order AND not explicitly hidden)
                const known = new Set([...deduped, ...Object.keys(hidden)]);
                const brandNew = defaults.filter(c => !known.has(c));
                for (const col of brandNew) {
                    const defIdx = defaults.indexOf(col);
                    let insertIdx = 0;
                    for (let i = defIdx - 1; i >= 0; i--) {
                        const prev = deduped.indexOf(defaults[i]);
                        if (prev !== -1) { insertIdx = prev + 1; break; }
                    }
                    deduped.splice(insertIdx, 0, col);
                }
                return deduped;
            }
        }
    } catch (e) {}
    return [...defaults];
}

function saveColumnOrder(type, order) {
    const key = type === 'pattern' ? 'patternColumnOrder' : (type === 'yarn' ? 'yarnColumnOrder' : 'hookColumnOrder');
    localStorage.setItem(key, JSON.stringify(order));
    syncSettingsToServer();
}

let _dragCol = null;

function onColDragStart(e) {
    _dragCol = e.target.dataset.col;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function onColDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.inventory-table th.drag-over').forEach(th => th.classList.remove('drag-over'));
}

function onColDragOver(e) {
    e.preventDefault();
    const th = e.target.closest('th');
    if (th && th.dataset.col !== _dragCol) th.classList.add('drag-over');
}

function onColDragLeave(e) {
    const th = e.target.closest('th');
    if (th) th.classList.remove('drag-over');
}

function onColDrop(e, type) {
    e.preventDefault();
    const th = e.target.closest('th');
    if (!th || !_dragCol) return;
    th.classList.remove('drag-over');
    const toCol = th.dataset.col;
    if (toCol === _dragCol) return;
    const order = getColumnOrder(type);
    const fromIdx = order.indexOf(_dragCol);
    const toIdx = order.indexOf(toCol);
    if (fromIdx === -1 || toIdx === -1) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, _dragCol);
    saveColumnOrder(type, order);
    if (type === 'pattern') displayPatterns(); else if (type === 'yarn') displayYarns(); else displayHooks();
}

function showColumnMenu(e, type) {
    e.preventDefault();
    // Remove existing menu
    const existing = document.querySelector('.column-menu');
    if (existing) existing.remove();

    const allCols = getColumnsConfig(type);
    const visibleCols = getColumnOrder(type);
    const menu = document.createElement('div');
    menu.className = 'column-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    // Build menu items for all columns
    for (const [key, col] of Object.entries(allCols)) {
        const item = document.createElement('div');
        item.className = 'column-menu-item';
        const checked = visibleCols.includes(key);
        item.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} data-col="${key}"><span class="col-check"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span><span>${col.label || key}</span>`;
        item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const cb = item.querySelector('input');
            const order = getColumnOrder(type);
            const hidden = getHiddenColumns(type);
            if (!cb.checked) {
                // Re-show column at its previous position
                cb.checked = true;
                if (!order.includes(key)) {
                    const afterCol = hidden[key];
                    let insertIdx = 0;
                    if (afterCol === null || afterCol === undefined) {
                        // Was first column — insert at beginning
                        insertIdx = 0;
                    } else {
                        const prevIdx = order.indexOf(afterCol);
                        insertIdx = prevIdx !== -1 ? prevIdx + 1 : order.length;
                    }
                    order.splice(insertIdx, 0, key);
                }
                delete hidden[key];
            } else {
                // Don't allow hiding all columns
                if (order.length <= 2) return;
                cb.checked = false;
                const idx = order.indexOf(key);
                // Remember the column before this one so we can restore position
                hidden[key] = idx > 0 ? order[idx - 1] : null;
                if (idx !== -1) order.splice(idx, 1);
            }
            saveHiddenColumns(type, hidden);
            saveColumnOrder(type, order);
            if (type === 'pattern') displayPatterns(); else if (type === 'yarn') displayYarns(); else displayHooks();
        });
        menu.appendChild(item);
    }

    document.body.appendChild(menu);

    // Keep menu in viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    // Close on click outside or Escape
    const close = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose); }
    };
    const escClose = (ev) => {
        if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose); }
    };
    setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', escClose); }, 0);
}

function showRowMenu(e, type, id) {
    e.preventDefault();
    e.stopPropagation();
    // Remove existing menu
    const existing = document.querySelector('.column-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'column-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const addItem = (label, icon, onClick, danger) => {
        const item = document.createElement('div');
        item.className = 'column-menu-item' + (danger ? ' context-menu-danger' : '');
        item.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${label}</span>`;
        item.addEventListener('click', (ev) => { menu.remove(); onClick(ev); });
        menu.appendChild(item);
    };

    const addDivider = () => {
        const div = document.createElement('div');
        div.className = 'context-menu-divider';
        menu.appendChild(div);
    };

    const addRatingRow = (currentRating, onRate) => {
        const row = document.createElement('div');
        row.className = 'column-menu-item context-menu-rating';
        row.innerHTML = `<span style="font-size:0.8rem;color:var(--text-muted);margin-right:4px">Rate</span>` +
            [1,2,3,4,5].map(i =>
                `<svg width="18" height="18" viewBox="0 0 24 24" fill="${i <= currentRating ? '#eab308' : 'none'}" stroke="${i <= currentRating ? '#eab308' : '#666'}" stroke-width="2" style="cursor:pointer" data-value="${i}">${STAR_SVG}</svg>`
            ).join('') +
            (currentRating > 0 ? `<span class="star-rating-clear" data-value="0" title="Clear rating" style="margin-left:4px;cursor:pointer;color:var(--text-muted)">&times;</span>` : '');
        row.addEventListener('click', (ev) => {
            const target = ev.target.closest('[data-value]');
            if (!target) return;
            const val = parseInt(target.dataset.value);
            menu.remove();
            onRate(val);
        });
        menu.appendChild(row);
    };

    if (type === 'pattern') {
        const p = patterns.find(x => x.id == id);
        if (!p) return;
        addItem(p.is_current ? 'Remove from In Progress' : 'Mark In Progress',
            '<polygon points="5 3 19 12 5 21 5 3"></polygon>',
            () => toggleCurrent(id, !p.is_current));
        addItem(p.is_favorite ? 'Unfavorite' : 'Favorite',
            '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>',
            () => toggleFavorite(id, !p.is_favorite));
        addItem(p.completed ? 'Mark Incomplete' : 'Mark Complete',
            '<polyline points="20 6 9 17 4 12"></polyline>',
            () => toggleComplete(id, !p.completed));
        addRatingRow(p.rating || 0, (val) => setPatternRating(id, val));
        addDivider();
        addItem('Edit', '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>', () => openEditModal(id));
        addItem('Duplicate', '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>', () => duplicatePattern(id));
        addItem('Add to Project', '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>', () => addPatternsToNewProject([id]));
        addDivider();
        addItem(enableDirectDelete ? 'Delete' : 'Archive',
            '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
            () => { enableDirectDelete ? deletePattern(id) : archivePattern(id); }, true);
    } else if (type === 'yarn') {
        const y = yarns.find(x => x.id == id);
        if (!y) return;
        addItem(y.is_favorite ? 'Unfavorite' : 'Favorite',
            '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>',
            () => toggleYarnFavorite(id, !y.is_favorite));
        addRatingRow(y.rating || 0, (val) => setInventoryRating('yarn', id, val));
        addItem('Edit', '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>', () => openYarnModal(id));
        addItem('Duplicate', '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>', () => duplicateYarn(id));
        addDivider();
        addItem('Delete', '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
            () => deleteYarn(id), true);
    } else if (type === 'hook') {
        const h = hooks.find(x => x.id == id);
        if (!h) return;
        addItem(h.is_favorite ? 'Unfavorite' : 'Favorite',
            '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>',
            () => toggleHookFavorite(id, !h.is_favorite));
        addRatingRow(h.rating || 0, (val) => setInventoryRating('hook', id, val));
        addItem('Edit', '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>', () => openHookModal(id));
        addItem('Duplicate', '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>', () => duplicateHook(id));
        addDivider();
        addItem('Delete', '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
            () => deleteHook(id), true);
    }

    document.body.appendChild(menu);

    // Keep menu in viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    // Close on click outside or Escape
    const close = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose); }
    };
    const escClose = (ev) => {
        if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose); }
    };
    setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', escClose); }, 0);
}

function initListRowLongPress(type) {
    const table = document.querySelector(`.inventory-table[data-type="${type}"]`);
    if (!table) return;
    table.querySelectorAll('tbody tr').forEach(row => {
        const id = parseInt(row.dataset.patternId || row.dataset.itemId);
        if (!id) return;
        let timer, triggered = false;
        row.addEventListener('touchstart', (e) => {
            triggered = false;
            timer = setTimeout(() => {
                triggered = true;
                if (navigator.vibrate) navigator.vibrate(30);
                const touch = e.changedTouches[0];
                showRowMenu({ preventDefault(){}, stopPropagation(){}, clientX: touch.clientX, clientY: touch.clientY }, type, id);
            }, 500);
        }, { passive: true });
        row.addEventListener('touchend', (e) => {
            clearTimeout(timer);
            if (triggered) e.preventDefault();
        });
        row.addEventListener('touchmove', () => { clearTimeout(timer); }, { passive: true });
        row.addEventListener('contextmenu', (e) => { if (timer || triggered) e.preventDefault(); });
    });
}

// --- Library list view functions ---

function sortPatternList(items, sortState) {
    const { col, dir } = sortState;
    return [...items].sort((a, b) => {
        let va, vb;
        if (col === 'name') { va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); }
        else if (col === 'category') { va = (a.category || '').toLowerCase(); vb = (b.category || '').toLowerCase(); }
        else if (col === 'type') { va = a.pattern_type || ''; vb = b.pattern_type || ''; }
        else if (col === 'status') {
            const s = p => p.completed ? 2 : (p.is_current ? 1 : 0);
            va = s(a); vb = s(b);
        }
        else if (col === 'added') { va = a.upload_date ? new Date(a.upload_date).getTime() : 0; vb = b.upload_date ? new Date(b.upload_date).getTime() : 0; }
        else if (col === 'opened') { va = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0; vb = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0; }
        else if (col === 'time') { va = a.timer_seconds || 0; vb = b.timer_seconds || 0; }
        else { va = (a[col] || '').toString().toLowerCase(); vb = (b[col] || '').toString().toLowerCase(); }
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
    });
}

function togglePatternListSort(col) {
    if (col === 'thumbnail') return;
    if (patternListSort.col === col) {
        patternListSort.dir = patternListSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        patternListSort.col = col;
        patternListSort.dir = 'asc';
    }
    displayPatterns();
}

function handlePatternRowClick(event, patternId) {
    if (event.target.closest('.bulk-select-checkbox')) return;
    if (libraryEditMode || selectedPatternIds.size > 0) {
        const row = event.currentTarget;
        togglePatternRowSelect(patternId, row.querySelector('.bulk-select-checkbox') || row);
        return;
    }
    if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const pattern = patterns.find(p => p.id === patternId);
        const slug = pattern ? getPatternSlug(pattern) : patternId;
        window.open(window.location.origin + window.location.pathname + '#pattern/' + slug, '_blank');
    } else {
        openPDFViewer(patternId);
    }
}

function togglePatternRowSelect(patternId, el) {
    if (selectedPatternIds.has(patternId)) {
        selectedPatternIds.delete(patternId);
    } else {
        selectedPatternIds.add(patternId);
    }
    const row = el.closest('tr');
    if (row) row.classList.toggle('bulk-selected', selectedPatternIds.has(patternId));
    updateBulkToolbar();
}

function toggleLibraryEditMode() {
    libraryEditMode = !libraryEditMode;
    const btn = document.getElementById('library-edit-btn');
    const mobileBtn = document.getElementById('library-mobile-edit-btn');
    if (btn) btn.classList.toggle('active', libraryEditMode);
    if (mobileBtn) mobileBtn.classList.toggle('active', libraryEditMode);
    if (!libraryEditMode) {
        clearBulkSelection();
    }
    // Re-render to show/hide checkbox column
    displayPatterns();
}

function exitLibraryEditMode() {
    if (!libraryEditMode) return;
    libraryEditMode = false;
    const btn = document.getElementById('library-edit-btn');
    const mobileBtn = document.getElementById('library-mobile-edit-btn');
    if (btn) btn.classList.remove('active');
    if (mobileBtn) mobileBtn.classList.remove('active');
    clearBulkSelection();
    displayPatterns();
}

// --- Yarn CRUD ---

async function loadYarns() {
    try {
        const response = await fetch(`${API_URL}/api/yarns`);
        if (!response.ok) return;
        yarns = await response.json();
        displayYarns();
        updateTabCounts();
    } catch (error) {
        console.error('Error loading yarns:', error);
    }
}

function displayYarns() {
    const grid = document.getElementById('yarn-grid');
    if (!grid) return;
    const query = (document.getElementById('inventory-search')?.value || '').toLowerCase();
    let filtered = yarns;
    if (query) {
        filtered = filtered.filter(y =>
            (y.brand || '').toLowerCase().includes(query) ||
            (y.name || '').toLowerCase().includes(query) ||
            (y.color || '').toLowerCase().includes(query) ||
            (y.weight_category || '').toLowerCase().includes(query) ||
            (y.fiber_content || '').toLowerCase().includes(query)
        );
    }
    // Sidebar filters
    const weightFilter = document.getElementById('yarn-weight-filter')?.value;
    if (weightFilter && weightFilter !== 'all') {
        filtered = filtered.filter(y => y.weight_category === weightFilter);
    }
    const brandFilter = document.getElementById('yarn-brand-filter')?.value;
    if (brandFilter && brandFilter !== 'all') {
        filtered = filtered.filter(y => y.brand === brandFilter);
    }
    const yarnRatingFilter = document.getElementById('yarn-rating-filter')?.value;
    if (yarnRatingFilter && yarnRatingFilter !== 'all') {
        filtered = filtered.filter(y => {
            if (yarnRatingFilter === 'unrated') return !y.rating;
            return (y.rating || 0) === parseInt(yarnRatingFilter);
        });
    }
    // Sort: sidebar sort for card view, column header sort for list view
    if (inventoryView !== 'list') {
        const sortVal = document.getElementById('yarn-sort-select')?.value || 'brand-asc';
        const [sortCol, sortDir] = sortVal.split('-');
        const colMap = { brand: 'brand', name: 'name', weight: 'weight_category', quantity: 'quantity', date: 'created_at', rating: 'rating' };
        filtered = sortInventory(filtered, { col: colMap[sortCol] || sortCol, dir: sortDir });
    }

    // Remove early view styles once JS takes over
    const earlyViewStyle = document.getElementById('early-view-style');
    if (earlyViewStyle) earlyViewStyle.remove();
    // Show/hide sidebar and toggle based on view
    const sidebar = document.getElementById('yarn-sidebar');
    const sidebarToggle = sidebar?.closest('.inventory-layout')?.querySelector('.inv-sidebar-toggle');
    if (inventoryView === 'list') {
        if (sidebar) sidebar.style.display = 'none';
        if (sidebarToggle) sidebarToggle.style.display = 'none';
    } else {
        if (sidebarToggle) sidebarToggle.style.display = '';
        if (sidebar && localStorage.getItem('yarn-sidebarCollapsed') !== 'true') sidebar.style.display = '';
    }

    if (filtered.length === 0) {
        grid.innerHTML = `<p class="empty-state">${query || (weightFilter && weightFilter !== 'all') || (brandFilter && brandFilter !== 'all') ? 'No yarn matches your filters.' : 'No yarn in your inventory yet. Add some to get started!'}</p>`;
        grid.className = 'patterns-grid';
        return;
    }
    if (inventoryView === 'list') {
        filtered = sortInventory(filtered, yarnSort);
        const cols = getColumnOrder('yarn');
        const arrow = (col) => yarnSort.col === col ? (yarnSort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span style="visibility:hidden">▲</span>';
        const cbStyle = 'style="width:40px;min-width:40px;padding:8px 6px;text-align:center"';
        const cbTh = inventoryEditMode ? `<th ${cbStyle}></th>` : '';
        const cbTd = (y) => inventoryEditMode ? `<td ${cbStyle}><div class="bulk-select-checkbox" onclick="event.stopPropagation(); toggleInventorySelect('yarn',${y.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div></td>` : '';
        grid.className = 'inventory-list-wrap';
        grid.innerHTML = `<table class="inventory-table" data-type="yarn">
            <thead><tr>${cbTh}${cols.map(c => `<th data-col="${c}"${c === 'thumbnail' ? ' class="col-thumbnail"' : ''} draggable="true" onclick="toggleYarnSort('${c}')" oncontextmenu="showColumnMenu(event,'yarn')" ondragstart="onColDragStart(event)" ondragend="onColDragEnd(event)" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,'yarn')">${YARN_COLUMNS[c].label}${c === 'thumbnail' ? '' : arrow(c)}</th>`).join('')}</tr></thead>
            <tbody>${filtered.map(y => `<tr onclick="handleInventoryRowClick(event,'yarn',${y.id})" oncontextmenu="showRowMenu(event,'yarn',${y.id})" class="${selectedYarnIds.has(y.id) ? 'bulk-selected' : ''}" data-item-id="${y.id}">${cbTd(y)}${cols.map(c => `<td${c === 'thumbnail' ? ' class="col-thumbnail"' : ''}>${YARN_COLUMNS[c].value(y)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>`;
        initListRowLongPress('yarn');
    } else {
        grid.className = 'patterns-grid' + (inventoryEditMode ? ' bulk-edit-mode' : '');
        grid.innerHTML = filtered.map(renderYarnCard).join('');
        initInventoryCardLongPress('yarn');
    }
    // Populate brand filter options
    populateYarnBrandFilter();
}

function renderYarnCard(yarn) {
    const brandText = escapeHtml(yarn.brand || 'Unknown Brand');
    const nameText = escapeHtml(yarn.name || '');
    const colorText = escapeHtml(yarn.color || '');
    const subtitle = [nameText, colorText].filter(Boolean).join(' — ');
    const qty = parseFloat(yarn.quantity) || 0;
    const isSelected = selectedYarnIds.has(yarn.id);
    return `
        <div class="pattern-card yarn-card${isSelected ? ' bulk-selected' : ''}" onclick="handleInventoryCardClick(event,'yarn',${yarn.id})" data-yarn-id="${yarn.id}">
            <div class="card-favorite-toggle ${yarn.is_favorite ? 'active' : ''}" onclick="event.stopPropagation(); toggleYarnFavorite(${yarn.id}, ${!yarn.is_favorite})" title="${yarn.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="${yarn.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </div>
            <div class="bulk-select-checkbox" onclick="event.stopPropagation(); toggleInventorySelect('yarn',${yarn.id},this)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            ${yarn.thumbnail
                ? `<img src="${API_URL}/api/yarns/${yarn.id}/thumbnail?t=${Date.now()}" class="pattern-thumbnail" alt="${colorText}">`
                : `<div class="yarn-swatch"><svg width="56" height="56" viewBox="0 0 100 125" fill="currentColor"><g><g><path d="M47.6,34.1c-1.4,1-2.7,2.1-4.1,3.3c5.1,4.4,12.8,15.9,13.9,29c1.8-2.1,3.2-4.6,4.3-7.2C59.6,46.6,51.3,36.3,47.6,34.1z"/><path d="M45.2,60.8c-6.4,4.9-14,8.3-21,9.4v0c-0.2,1-0.3,2-0.4,2.9c1.2,0.6,2.4,1.1,3.6,1.6c8.2-1,15.4-5.1,19.3-7.8C46.4,64.8,45.8,62.7,45.2,60.8z"/><path d="M34.6,47.6c-2.6,3.4-4.6,6.9-6.2,10.2c4.3-1.7,8.6-4.2,12.2-7.1c-1.4-2.3-2.8-4.2-4-5.7C35.9,45.8,35.2,46.7,34.6,47.6z"/><path d="M44.8,23.1c-2.7-0.9-5.7-1.4-8.7-1.3c-4.9,3.3-9.5,8-14.3,14.4c-6.4,8.5-9.4,17.1-10.5,23.3c0.9,2.2,2.1,4.3,3.6,6.1c1-6.7,4.2-16,11.1-25.2C32.3,32.1,38.3,26.5,44.8,23.1z"/><path d="M53.3,27.6c-1.5-1.2-3.2-2.3-5-3.1c-7,3-13.4,8.6-20.1,17.5c-7.5,10-10.4,20.2-10.9,26.4c1.2,1.2,2.5,2.2,3.9,3.2c0.9-6.7,4.1-16.3,11.2-25.7C39.3,36.7,46,30.9,53.3,27.6z"/><path d="M63.3,53.9c0.4-2.1,0.5-4.4,0.4-6.6c-0.5-6.9-3.5-13.1-8.1-17.6c-1.9,0.7-3.8,1.7-5.6,2.8C54.1,35.6,60.3,43.7,63.3,53.9z"/><path d="M30.8,22.4C17.8,25.2,8.4,37.2,9.3,50.9c0.1,1.1,0.2,2.2,0.4,3.3c1.7-5.8,4.7-12.8,9.9-19.6C23.4,29.6,27.1,25.5,30.8,22.4z"/><path d="M33.9,76.2c1.4,0.1,2.9,0.2,4.4,0.1c3.1-0.2,6-0.9,8.8-2.1c0.1-1.4,0.1-2.8,0-4.2C43.9,72,39.3,74.6,33.9,76.2z"/><path d="M24.8,67.3c6.5-1.2,13.5-4.5,19.4-9.2l0,0c-0.7-1.8-1.5-3.5-2.3-5c-4.5,3.5-9.9,6.4-15.1,8.1C26,63.4,25.3,65.4,24.8,67.3z"/></g><g><path d="M91.6,80c-4.1-7.4-7.4-10.9-14.6-10.6c-2.8,0.1-5.4,1.8-8.2,3.7c-4,2.6-7.8,5.1-11.7,3c-1-0.6-1.7-1.5-2.2-2.4c-0.9,0.7-1.8,1.3-2.8,1.9c0.7,1.3,1.8,2.6,3.4,3.5c5.7,3.1,10.9-0.4,15.2-3.1c2.4-1.6,4.7-3.1,6.5-3.1c5.5-0.2,7.7,2.1,11.6,8.9c0.4,0.8,1.5,1.1,2.3,0.6C91.7,81.8,92,80.8,91.6,80z"/><path d="M50.1,72.7c0.4-0.2,0.4-0.3,0.8-0.5c0,0,0,0,0,0c0,0,0,0.1,0,0.1c1-0.7,2.1-1.4,3.1-2.3c0,0,0-0.1,0-0.1c0.3-0.2,0.6-0.5,0.9-0.7c-0.2-12.9-8-25.4-13.3-29.8c-1.1,1.1-2.1,2.2-3.2,3.5c5.5,6.3,10.7,16.6,11.4,27.1C49.8,70.9,50.1,71.7,50.1,72.7z"/></g></g></svg></div>`
            }
            ${yarn.rating ? `<span class="rating-badge">${ratingBadgeHtml(yarn.rating)}</span>` : ''}
            <h3 title="${brandText}">${brandText}</h3>
            <p class="pattern-description">${subtitle}</p>
            <div class="yarn-meta">
                ${yarn.weight_category ? `<span class="yarn-badge">${escapeHtml(yarn.weight_category)}</span>` : ''}
                <span class="yarn-qty">${qty % 1 === 0 ? qty : qty.toFixed(1)} skein${qty !== 1 ? 's' : ''}</span>
            </div>
            ${yarn.pattern_count > 0 ? `<div class="yarn-linked">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                ${yarn.pattern_count} pattern${yarn.pattern_count > 1 ? 's' : ''}
            </div>` : ''}
        </div>
    `;
}

function openYarnModal(yarnId = null) {
    editingYarnId = yarnId;
    const yarn = yarnId ? yarns.find(y => y.id === yarnId) : null;

    document.getElementById('yarn-modal-title').textContent = yarn ? 'Edit Yarn' : 'Add Yarn';
    document.getElementById('save-yarn-btn').textContent = yarn ? 'Save Changes' : 'Add Yarn';
    document.getElementById('delete-yarn-btn').style.display = yarn ? '' : 'none';
    document.getElementById('duplicate-yarn-btn').style.display = yarn ? '' : 'none';

    document.getElementById('yarn-brand').value = yarn?.brand || '';
    document.getElementById('yarn-name').value = yarn?.name || '';
    document.getElementById('yarn-color').value = yarn?.color || '';
    document.getElementById('yarn-dye-lot').value = yarn?.dye_lot || '';
    document.getElementById('yarn-weight').value = yarn?.weight_category || '';
    document.getElementById('yarn-quantity').value = yarn?.quantity || 1;
    document.getElementById('yarn-fiber').value = yarn?.fiber_content || '';
    document.getElementById('yarn-yardage').value = yarn?.yardage || '';
    document.getElementById('yarn-unit-weight').value = yarn?.unit_weight || '';
    document.getElementById('yarn-gauge').value = yarn?.gauge || '';
    document.getElementById('yarn-rec-size').value = yarn?.needle_size || yarn?.hook_size || '';
    document.getElementById('yarn-url').value = yarn?.url || '';
    document.getElementById('yarn-notes').value = yarn?.notes || '';

    // Rating
    document.getElementById('yarn-rating').innerHTML = ratingInputHtml('yarn-rating-input', yarn?.rating || 0);

    // Favorite button
    const favBtn = document.getElementById('yarn-favorite-btn');
    if (yarn?.is_favorite) {
        favBtn.classList.add('active');
    } else {
        favBtn.classList.remove('active');
    }

    // Thumbnail
    if (yarn?.thumbnail) {
        setThumbnailSelectorImage('yarn', `${API_URL}/api/yarns/${yarn.id}/thumbnail?t=${Date.now()}`);
    } else {
        clearThumbnailSelector('yarn');
    }

    // Patterns tab
    const tabsEl = document.getElementById('yarn-modal-tabs');
    const patternsContainer = document.getElementById('yarn-linked-patterns');
    if (yarn && yarn.pattern_count > 0) {
        tabsEl.style.display = '';
        const patternsTab = tabsEl.querySelector('[data-tab="patterns"]');
        patternsTab.textContent = `Patterns (${yarn.pattern_count})`;
        patternsContainer.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Loading…</p>';
        fetch(`${API_URL}/api/yarns/${yarn.id}/patterns`)
            .then(r => r.json())
            .then(patterns => { patternsContainer.innerHTML = renderLinkedPatterns(patterns); })
            .catch(() => { patternsContainer.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Could not load patterns.</p>'; });
    } else {
        tabsEl.style.display = 'none';
        patternsContainer.innerHTML = '';
    }
    resetEditModalTab('yarn');

    loadBrands();
    document.getElementById('yarn-modal').style.display = 'flex';
}

function closeYarnModal() {
    document.getElementById('yarn-modal').style.display = 'none';
    editingYarnId = null;
}

async function saveYarn() {
    const data = {
        name: document.getElementById('yarn-name').value.trim() || null,
        brand: document.getElementById('yarn-brand').value.trim() || null,
        color: document.getElementById('yarn-color').value.trim() || null,
        dye_lot: document.getElementById('yarn-dye-lot').value.trim() || null,
        weight_category: document.getElementById('yarn-weight').value || null,
        fiber_content: document.getElementById('yarn-fiber').value.trim() || null,
        quantity: parseFloat(document.getElementById('yarn-quantity').value) || 1,
        yardage: parseFloat(document.getElementById('yarn-yardage').value) || null,
        unit_weight: parseFloat(document.getElementById('yarn-unit-weight').value) || null,
        gauge: document.getElementById('yarn-gauge').value.trim() || null,
        needle_size: document.getElementById('yarn-rec-size').value.trim() || null,
        hook_size: null,
        url: document.getElementById('yarn-url').value.trim() || null,
        notes: document.getElementById('yarn-notes').value.trim() || null,
        rating: parseInt(document.getElementById('yarn-rating-input')?.dataset.rating) || 0,
        is_favorite: document.getElementById('yarn-favorite-btn').classList.contains('active')
    };

    try {
        let result;
        if (editingYarnId) {
            const response = await fetch(`${API_URL}/api/yarns/${editingYarnId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            result = await response.json();
        } else {
            const response = await fetch(`${API_URL}/api/yarns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            result = await response.json();
        }

        // Upload thumbnail if one was selected via thumbnail modal
        const thumbnailFile = getThumbnailFile('yarn');
        if (thumbnailFile) {
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);
            await fetch(`${API_URL}/api/yarns/${result.id}/thumbnail`, {
                method: 'POST',
                body: formData
            });
        }

        closeYarnModal();
        await loadYarns();
    } catch (error) {
        console.error('Error saving yarn:', error);
    }
}

function deleteYarn(yarnId) {
    const item = yarns.find(y => y.id == yarnId);
    if (!item) return;
    closeYarnModal();
    undoableDelete(
        'Yarn deleted',
        () => { yarns = yarns.filter(y => y.id != yarnId); displayYarns(); updateTabCounts(); },
        async () => { try { await fetch(`${API_URL}/api/yarns/${yarnId}`, { method: 'DELETE' }); } catch(e) { console.error('Error deleting yarn:', e); } },
        () => { yarns.push(item); displayYarns(); updateTabCounts(); }
    );
}

async function duplicateYarn(id) {
    try {
        const res = await fetch(`${API_URL}/api/yarns/${id}/duplicate`, { method: 'POST' });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const newYarn = await res.json();
        showToast(`Duplicated as "${newYarn.name}"`);
        await loadYarns();
    } catch (e) {
        showToast('Failed to duplicate: ' + e.message, 'error');
    }
}

// --- Hook CRUD ---

async function loadHooks() {
    try {
        const response = await fetch(`${API_URL}/api/hooks`);
        if (!response.ok) return;
        hooks = await response.json();
        displayHooks();
        updateTabCounts();
    } catch (error) {
        console.error('Error loading hooks:', error);
    }
}

function displayHooks() {
    const grid = document.getElementById('hooks-grid');
    if (!grid) return;
    const query = (document.getElementById('inventory-search')?.value || '').toLowerCase();
    let filtered = hooks;
    if (query) {
        filtered = filtered.filter(h =>
            (h.size_label || '').toLowerCase().includes(query) ||
            (h.brand || '').toLowerCase().includes(query) ||
            (h.name || '').toLowerCase().includes(query) ||
            (h.hook_type || '').toLowerCase().includes(query) ||
            (h.craft_type || '').toLowerCase().includes(query)
        );
    }
    // Sidebar filters
    const craftFilter = document.getElementById('hook-craft-filter')?.value;
    if (craftFilter && craftFilter !== 'all') {
        filtered = filtered.filter(h => h.craft_type === craftFilter);
    }
    const typeFilter = document.getElementById('hook-type-filter')?.value;
    if (typeFilter && typeFilter !== 'all') {
        filtered = filtered.filter(h => h.hook_type === typeFilter);
    }
    const brandFilter = document.getElementById('hook-brand-filter')?.value;
    if (brandFilter && brandFilter !== 'all') {
        filtered = filtered.filter(h => h.brand === brandFilter);
    }
    const hookRatingFilter = document.getElementById('hook-rating-filter')?.value;
    if (hookRatingFilter && hookRatingFilter !== 'all') {
        filtered = filtered.filter(h => {
            if (hookRatingFilter === 'unrated') return !h.rating;
            return (h.rating || 0) === parseInt(hookRatingFilter);
        });
    }
    // Sort: sidebar sort for card view, column header sort for list view
    if (inventoryView !== 'list') {
        const sortVal = document.getElementById('hook-sort-select')?.value || 'brand-asc';
        const [sortCol, sortDir] = sortVal.split('-');
        const colMap = { brand: 'brand', size: 'size_mm', quantity: 'quantity', date: 'created_at', rating: 'rating' };
        filtered = sortInventory(filtered, { col: colMap[sortCol] || sortCol, dir: sortDir });
    }

    // Show/hide sidebar and toggle based on view
    const sidebar = document.getElementById('hooks-sidebar');
    const sidebarToggle = sidebar?.closest('.inventory-layout')?.querySelector('.inv-sidebar-toggle');
    if (inventoryView === 'list') {
        if (sidebar) sidebar.style.display = 'none';
        if (sidebarToggle) sidebarToggle.style.display = 'none';
    } else {
        if (sidebarToggle) sidebarToggle.style.display = '';
        if (sidebar && localStorage.getItem('hooks-sidebarCollapsed') !== 'true') sidebar.style.display = '';
    }

    const hasFilters = query || (craftFilter && craftFilter !== 'all') || (typeFilter && typeFilter !== 'all') || (brandFilter && brandFilter !== 'all');
    if (filtered.length === 0) {
        grid.innerHTML = `<p class="empty-state">${hasFilters ? 'No hooks or needles match your filters.' : 'No hooks or needles in your inventory yet. Add some to get started!'}</p>`;
        grid.className = 'patterns-grid';
        return;
    }
    if (inventoryView === 'list') {
        filtered = sortInventory(filtered, hookSort);
        const cols = getColumnOrder('hook');
        const arrow = (col) => hookSort.col === col ? (hookSort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span style="visibility:hidden">▲</span>';
        const cbStyle = 'style="width:40px;min-width:40px;padding:8px 6px;text-align:center"';
        const cbTh = inventoryEditMode ? `<th ${cbStyle}></th>` : '';
        const cbTd = (h) => inventoryEditMode ? `<td ${cbStyle}><div class="bulk-select-checkbox" onclick="event.stopPropagation(); toggleInventorySelect('hook',${h.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div></td>` : '';
        grid.className = 'inventory-list-wrap';
        grid.innerHTML = `<table class="inventory-table" data-type="hook">
            <thead><tr>${cbTh}${cols.map(c => `<th data-col="${c}"${c === 'thumbnail' ? ' class="col-thumbnail"' : ''} draggable="true" onclick="toggleHookSort('${c}')" oncontextmenu="showColumnMenu(event,'hook')" ondragstart="onColDragStart(event)" ondragend="onColDragEnd(event)" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,'hook')">${HOOK_COLUMNS[c].label}${c === 'thumbnail' ? '' : arrow(c)}</th>`).join('')}</tr></thead>
            <tbody>${filtered.map(h => `<tr onclick="handleInventoryRowClick(event,'hook',${h.id})" oncontextmenu="showRowMenu(event,'hook',${h.id})" class="${selectedHookIds.has(h.id) ? 'bulk-selected' : ''}" data-item-id="${h.id}">${cbTd(h)}${cols.map(c => `<td${c === 'thumbnail' ? ' class="col-thumbnail"' : ''}>${HOOK_COLUMNS[c].value(h)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>`;
        initListRowLongPress('hook');
    } else {
        grid.className = 'patterns-grid' + (inventoryEditMode ? ' bulk-edit-mode' : '');
        grid.innerHTML = filtered.map(renderHookCard).join('');
        initInventoryCardLongPress('hook');
    }
    // Populate filter options
    populateHookFilters();
}

function renderHookCard(hook) {
    const sizeText = escapeHtml(hook.size_label || (hook.size_mm ? hook.size_mm + 'mm' : 'Unknown'));
    const isKnitting = hook.craft_type === 'knitting';
    const unitName = isKnitting ? 'needle' : 'hook';
    const detailParts = [hook.brand, hook.name, hook.hook_type];
    if (isKnitting && hook.length) detailParts.push(hook.length);
    const details = detailParts.filter(Boolean).map(escapeHtml).join(' / ');
    const isSelected = selectedHookIds.has(hook.id);
    return `
        <div class="pattern-card hook-card${isSelected ? ' bulk-selected' : ''}" onclick="handleInventoryCardClick(event,'hook',${hook.id})" data-hook-id="${hook.id}">
            <div class="card-favorite-toggle ${hook.is_favorite ? 'active' : ''}" onclick="event.stopPropagation(); toggleHookFavorite(${hook.id}, ${!hook.is_favorite})" title="${hook.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="${hook.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </div>
            <div class="bulk-select-checkbox" onclick="event.stopPropagation(); toggleInventorySelect('hook',${hook.id},this)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            ${hook.thumbnail
                ? `<img src="${API_URL}/api/hooks/${hook.id}/thumbnail?t=${Date.now()}" class="pattern-thumbnail" alt="${sizeText}">`
                : `<div class="hook-icon-placeholder">
                ${hookPlaceholderSvg(hook.craft_type, 56)}
                <span class="hook-size-overlay">${sizeText}</span>
            </div>`}
            ${hook.rating ? `<span class="rating-badge">${ratingBadgeHtml(hook.rating)}</span>` : ''}
            <h3>${sizeText}</h3>
            <p class="pattern-description">${details}</p>
            <div class="yarn-meta">
                <span class="yarn-qty">${hook.quantity || 1} ${unitName}${(hook.quantity || 1) !== 1 ? 's' : ''}</span>
            </div>
            ${hook.pattern_count > 0 ? `<div class="yarn-linked">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                ${hook.pattern_count} pattern${hook.pattern_count > 1 ? 's' : ''}
            </div>` : ''}
        </div>
    `;
}

function openHookModal(hookId = null) {
    editingHookId = hookId;
    const hook = hookId ? hooks.find(h => h.id === hookId) : null;

    const craftType = hook?.craft_type || 'crochet';
    const isKnitting = craftType === 'knitting';
    document.getElementById('hook-modal-title').textContent = hook
        ? (isKnitting ? 'Edit Needle' : 'Edit Hook')
        : 'Add Hook / Needle';
    document.getElementById('save-hook-btn').textContent = hook ? 'Save Changes' : 'Add';
    document.getElementById('delete-hook-btn').style.display = hook ? '' : 'none';
    document.getElementById('duplicate-hook-btn').style.display = hook ? '' : 'none';

    // Set craft type toggle and populate size/type selects
    setCraftType(craftType);

    // Set size select value
    const sizeSelect = document.getElementById('hook-size');
    if (hook?.size_mm) {
        const match = Array.from(sizeSelect.options).find(o => o.value.startsWith(hook.size_mm + '|'));
        sizeSelect.value = match ? match.value : '';
    } else {
        sizeSelect.value = '';
    }

    document.getElementById('hook-quantity').value = hook?.quantity || 1;
    document.getElementById('hook-brand').value = hook?.brand || '';
    document.getElementById('hook-name').value = hook?.name || '';
    document.getElementById('hook-type').value = hook?.hook_type || '';
    document.getElementById('hook-url').value = hook?.url || '';
    document.getElementById('hook-notes').value = hook?.notes || '';

    // Rating
    document.getElementById('hook-rating').innerHTML = ratingInputHtml('hook-rating-input', hook?.rating || 0);

    // Set length for knitting needles
    if (isKnitting && hook?.hook_type) {
        updateLengthOptions();
        document.getElementById('hook-length').value = hook?.length || '';
    }

    // Thumbnail
    if (hook?.thumbnail) {
        setThumbnailSelectorImage('hook', `${API_URL}/api/hooks/${hook.id}/thumbnail?t=${Date.now()}`);
    } else {
        clearThumbnailSelector('hook');
    }

    // Patterns tab
    const hookTabsEl = document.getElementById('hook-modal-tabs');
    const hookPatternsContainer = document.getElementById('hook-linked-patterns');
    if (hook && hook.pattern_count > 0) {
        hookTabsEl.style.display = '';
        const patternsTab = hookTabsEl.querySelector('[data-tab="patterns"]');
        patternsTab.textContent = `Patterns (${hook.pattern_count})`;
        hookPatternsContainer.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Loading…</p>';
        fetch(`${API_URL}/api/hooks/${hook.id}/patterns`)
            .then(r => r.json())
            .then(patterns => { hookPatternsContainer.innerHTML = renderLinkedPatterns(patterns); })
            .catch(() => { hookPatternsContainer.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Could not load patterns.</p>'; });
    } else {
        hookTabsEl.style.display = 'none';
        hookPatternsContainer.innerHTML = '';
    }
    resetEditModalTab('hook');

    loadBrands();
    document.getElementById('hook-modal').style.display = 'flex';
}

function closeHookModal() {
    document.getElementById('hook-modal').style.display = 'none';
    editingHookId = null;
}

async function saveHook() {
    const sizeValue = document.getElementById('hook-size').value;
    let size_mm = null, size_label = null;
    if (sizeValue) {
        const [mm, letter] = sizeValue.split('|');
        size_mm = parseFloat(mm);
        size_label = letter ? `${letter} (${mm}mm)` : `${mm}mm`;
    }

    const data = {
        craft_type: currentCraftType,
        name: document.getElementById('hook-name').value.trim() || null,
        brand: document.getElementById('hook-brand').value.trim() || null,
        size_mm,
        size_label,
        hook_type: document.getElementById('hook-type').value || null,
        length: (currentCraftType === 'knitting' ? document.getElementById('hook-length').value : null) || null,
        quantity: parseInt(document.getElementById('hook-quantity').value) || 1,
        url: document.getElementById('hook-url').value.trim() || null,
        notes: document.getElementById('hook-notes').value.trim() || null,
        rating: parseInt(document.getElementById('hook-rating-input')?.dataset.rating) || 0
    };

    try {
        let result;
        if (editingHookId) {
            const response = await fetch(`${API_URL}/api/hooks/${editingHookId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            result = await response.json();
        } else {
            const response = await fetch(`${API_URL}/api/hooks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            result = await response.json();
        }

        // Upload thumbnail if one was selected
        const thumbnailFile = getThumbnailFile('hook');
        if (thumbnailFile) {
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);
            await fetch(`${API_URL}/api/hooks/${result.id}/thumbnail`, {
                method: 'POST',
                body: formData
            });
        }

        closeHookModal();
        await loadHooks();
    } catch (error) {
        console.error('Error saving hook:', error);
    }
}

function deleteHook(hookId) {
    const item = hooks.find(h => h.id == hookId);
    if (!item) return;
    closeHookModal();
    undoableDelete(
        'Hook deleted',
        () => { hooks = hooks.filter(h => h.id != hookId); displayHooks(); updateTabCounts(); },
        async () => { try { await fetch(`${API_URL}/api/hooks/${hookId}`, { method: 'DELETE' }); } catch(e) { console.error('Error deleting hook:', e); } },
        () => { hooks.push(item); displayHooks(); updateTabCounts(); }
    );
}

async function duplicateHook(id) {
    try {
        const res = await fetch(`${API_URL}/api/hooks/${id}/duplicate`, { method: 'POST' });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const newHook = await res.json();
        showToast(`Duplicated as "${newHook.name}"`);
        await loadHooks();
    } catch (e) {
        showToast('Failed to duplicate: ' + e.message, 'error');
    }
}

// --- URL image import ---

async function importImageFromUrl(type) {
    const urlInput = document.getElementById(`${type}-url`);
    const btn = document.getElementById(`${type}-import-img-btn`);
    const url = urlInput?.value?.trim();
    if (!url) return;

    const origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-small"></span> Importing…';

    try {
        // Use Ravelry API for Ravelry yarn URLs
        const isRavelryYarn = type === 'yarn' && /ravelry\.com\/yarns\/library\//.test(url);
        const endpoint = isRavelryYarn ? `${API_URL}/api/ravelry/import-yarn-url` : `${API_URL}/api/fetch-url-image`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, type })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to fetch data');

        // Set the thumbnail preview with the fetched image
        const preview = document.getElementById(`${type}-thumbnail-preview`);
        if (preview && data.image) {
            preview.innerHTML = `<img src="${data.image}">`;
            preview.classList.add('has-image');
            preview.dataset.thumbnailBlob = data.image;
        }

        // Auto-fill empty form fields from extracted product data
        if (data.fields) {
            const filled = [];
            if (type === 'yarn') {
                filled.push(...autoFillYarnFields(data.fields));
            } else if (type === 'hook') {
                filled.push(...autoFillHookFields(data.fields));
            }
            // Brief highlight on filled fields
            filled.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.classList.add('url-autofilled');
                    setTimeout(() => el.classList.remove('url-autofilled'), 2000);
                }
            });
        }
    } catch (error) {
        showToast(error.message || 'Could not import from URL', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
    }
}

function autoFillYarnFields(fields) {
    const filled = [];
    const fill = (id, value) => {
        const el = document.getElementById(id);
        if (el && !el.value && value) {
            el.value = value;
            filled.push(id);
        }
    };
    fill('yarn-brand', fields.brand);
    fill('yarn-name', fields.name);
    fill('yarn-color', fields.color);
    fill('yarn-fiber', fields.fiber_content);
    if (fields.weight_category) {
        const el = document.getElementById('yarn-weight');
        if (el && !el.value) {
            el.value = fields.weight_category;
            filled.push('yarn-weight');
        }
    }
    fill('yarn-yardage', fields.yardage);
    fill('yarn-unit-weight', fields.unit_weight);
    fill('yarn-gauge', fields.gauge);
    fill('yarn-rec-size', fields.needle_size || fields.hook_size);
    return filled;
}

function autoFillHookFields(fields) {
    const filled = [];
    const fill = (id, value) => {
        const el = document.getElementById(id);
        if (el && !el.value && value) {
            el.value = value;
            filled.push(id);
        }
    };
    fill('hook-brand', fields.brand);
    fill('hook-name', fields.name);
    if (fields.craft_type) {
        setCraftType(fields.craft_type);
    }
    if (fields.size_mm) {
        const sizeSelect = document.getElementById('hook-size');
        if (sizeSelect && !sizeSelect.value) {
            const match = Array.from(sizeSelect.options).find(o => o.value.startsWith(fields.size_mm + '|'));
            if (match) {
                sizeSelect.value = match.value;
                filled.push('hook-size');
            }
        }
    }
    return filled;
}

// --- Brand autocomplete ---

const DEFAULT_YARN_BRANDS = [
    'Bernat', 'Big Twist', 'Caron', 'Cascade', 'Drops',
    'Fibra Natura', 'Hayfield', 'Hobbii', 'Ice Yarns', 'James C. Brett',
    'King Cole', 'KnitPicks', 'Lion Brand', 'Loops & Threads',
    'Malabrigo', 'Mandala', 'Paintbox', 'Patons', 'Premier',
    'Red Heart', 'Rico', 'Rowan', 'Scheepjes', 'Sirdar',
    'Stylecraft', 'Sublime', 'WeCrochet', 'Yarn Bee', 'Yarnspirations',
];

const DEFAULT_HOOK_BRANDS = [
    'Addi', 'Boye', 'ChiaoGoo', 'Clover', 'Denise',
    'Furls', 'HiyaHiya', 'KnitPicks', 'Knitter\'s Pride',
    'Lykke', 'Pony', 'Prym', 'Susan Bates', 'Takumi',
    'Tulip', 'WeCrochet',
];

let userBrands = [];

function getHiddenBrands() {
    try { return JSON.parse(localStorage.getItem('hiddenBrands') || '[]'); } catch { return []; }
}

function setHiddenBrands(list) {
    localStorage.setItem('hiddenBrands', JSON.stringify(list));
}

function buildBrandList(defaults) {
    const hidden = new Set(getHiddenBrands().map(b => b.toLowerCase()));
    const brandMap = {};
    defaults.forEach(b => { if (!hidden.has(b.toLowerCase())) brandMap[b.toLowerCase()] = b; });
    userBrands.forEach(b => { if (!hidden.has(b.toLowerCase())) brandMap[b.toLowerCase()] = b; });
    return Object.keys(brandMap).sort().map(k => brandMap[k]);
}

async function loadBrands() {
    try {
        const res = await fetch(`${API_URL}/api/brands`);
        userBrands = await res.json();
    } catch (e) {
        console.error('Error loading brands:', e);
    }
}

function initBrandAutocomplete(inputId, listId, defaults) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;

    function showSuggestions() {
        const brands = buildBrandList(defaults);
        const val = input.value.toLowerCase().trim();
        let matches;
        if (!val) {
            matches = brands;
        } else {
            matches = brands.filter(b => b.toLowerCase().includes(val) && b.toLowerCase() !== val);
        }
        const exactMatch = val && brands.some(b => b.toLowerCase() === val);
        let html = matches.map(b =>
            `<div class="brand-autocomplete-item"><span class="brand-autocomplete-label">${escapeHtml(b)}</span><span class="brand-autocomplete-x" data-brand="${escapeHtml(b)}">&times;</span></div>`
        ).join('');
        if (val && !exactMatch) {
            html += `<div class="brand-autocomplete-item brand-add-new">+ Add "${escapeHtml(input.value.trim())}"</div>`;
        }
        if (!html) { list.style.display = 'none'; return; }
        list.innerHTML = html;
        list.style.display = 'block';
    }

    input.addEventListener('input', showSuggestions);
    input.addEventListener('focus', showSuggestions);

    input.addEventListener('blur', () => {
        setTimeout(() => { list.style.display = 'none'; }, 200);
    });

    list.addEventListener('click', (e) => {
        // Handle × delete button
        const xBtn = e.target.closest('.brand-autocomplete-x');
        if (xBtn) {
            e.stopPropagation();
            const brand = xBtn.dataset.brand;
            const hidden = getHiddenBrands();
            if (!hidden.some(h => h.toLowerCase() === brand.toLowerCase())) {
                hidden.push(brand);
                setHiddenBrands(hidden);
            }
            showSuggestions();
            return;
        }
        const item = e.target.closest('.brand-autocomplete-item');
        if (item) {
            if (item.classList.contains('brand-add-new')) {
                const newBrand = input.value.trim();
                if (newBrand && !defaults.includes(newBrand)) {
                    defaults.push(newBrand);
                }
                list.style.display = 'none';
            } else {
                const label = item.querySelector('.brand-autocomplete-label');
                input.value = label ? label.textContent : item.textContent;
                list.style.display = 'none';
            }
        }
    });
}

// --- Yarn selector for pattern edit modal ---

function createYarnSelector(selectedYarnIds = []) {
    if (yarns.length === 0) {
        return '<p class="text-muted" style="font-size: 0.85rem; margin: 0;">No yarn in inventory. Add yarn from the Inventory tab.</p>';
    }
    const brands = {};
    yarns.forEach(y => { const b = y.brand || 'Other'; if (!brands[b]) brands[b] = []; brands[b].push(y); });
    const selectedPills = yarns.filter(y => selectedYarnIds.includes(y.id)).map(y => {
        const label = [y.name, y.color].filter(Boolean).join(' - ') || y.brand || 'Unnamed';
        return `<span class="inv-selected-pill" data-id="${y.id}" onclick="toggleInvCheckbox(this, 'yarn-select-cb')">${escapeHtml(label)} ×</span>`;
    }).join('');
    const brandGroups = Object.keys(brands).sort().map(brand => {
        const items = brands[brand].map(y => {
            const checked = selectedYarnIds.includes(y.id);
            const sub = [y.name, y.color].filter(Boolean).join(' - ') || 'Unnamed';
            return `<label class="inv-selector-item${checked ? ' selected' : ''}">
                <input type="checkbox" class="yarn-select-cb" value="${y.id}" ${checked ? 'checked' : ''}
                    onchange="this.parentElement.classList.toggle('selected', this.checked); updateInvSelectorPills(this, 'yarn'); updateInventoryBadgeFromCheckbox(this); autoSaveInventoryLinks(this)">
                <span class="inv-item-name">${escapeHtml(sub)}</span>
            </label>`;
        }).join('');
        return `<div class="inv-brand-group"><div class="inv-brand-label">${escapeHtml(brand)}</div><div class="inv-brand-items">${items}</div></div>`;
    }).join('');
    return `<div class="inv-selector">
        <div class="inv-selected-pills">${selectedPills}</div>
        <button type="button" class="inv-add-btn" data-label="+ Add Yarn" onclick="toggleInvDropdown(this)">+ Add Yarn</button>
        <div class="inv-dropdown" style="display:none;">
            <input type="text" class="inv-selector-search" placeholder="Search yarn..." oninput="filterInvSelector(this)">
            <div class="inv-selector-list">${brandGroups}</div>
        </div>
    </div>`;
}

function getSelectedYarnIds(containerId = 'edit-pattern-yarns-container') {
    return Array.from(document.querySelectorAll(`#${containerId} .yarn-select-cb:checked`))
        .map(cb => parseInt(cb.value));
}

// --- Hook selector for pattern edit modal ---

function createHookSelector(selectedHookIds = []) {
    if (hooks.length === 0) {
        return '<p class="text-muted" style="font-size: 0.85rem; margin: 0;">No hooks/needles in inventory. Add from the Inventory tab.</p>';
    }
    const brands = {};
    hooks.forEach(h => { const b = h.brand || 'Other'; if (!brands[b]) brands[b] = []; brands[b].push(h); });
    const selectedPills = hooks.filter(h => selectedHookIds.includes(h.id)).map(h => {
        const label = [h.name, h.size_label].filter(Boolean).join(' - ') || h.brand || 'Unnamed';
        return `<span class="inv-selected-pill" data-id="${h.id}" onclick="toggleInvCheckbox(this, 'hook-select-cb')">${escapeHtml(label)} ×</span>`;
    }).join('');
    const brandGroups = Object.keys(brands).sort().map(brand => {
        const items = brands[brand].map(h => {
            const checked = selectedHookIds.includes(h.id);
            const sub = [h.name, h.size_label].filter(Boolean).join(' - ') || 'Unnamed';
            return `<label class="inv-selector-item${checked ? ' selected' : ''}">
                <input type="checkbox" class="hook-select-cb" value="${h.id}" ${checked ? 'checked' : ''}
                    onchange="this.parentElement.classList.toggle('selected', this.checked); updateInvSelectorPills(this, 'hook'); updateInventoryBadgeFromCheckbox(this); autoSaveInventoryLinks(this)">
                <span class="inv-item-name">${escapeHtml(sub)}</span>
            </label>`;
        }).join('');
        return `<div class="inv-brand-group"><div class="inv-brand-label">${escapeHtml(brand)}</div><div class="inv-brand-items">${items}</div></div>`;
    }).join('');
    return `<div class="inv-selector">
        <div class="inv-selected-pills">${selectedPills}</div>
        <button type="button" class="inv-add-btn" data-label="+ Add Hook" onclick="toggleInvDropdown(this)">+ Add Hook</button>
        <div class="inv-dropdown" style="display:none;">
            <input type="text" class="inv-selector-search" placeholder="Search hooks..." oninput="filterInvSelector(this)">
            <div class="inv-selector-list">${brandGroups}</div>
        </div>
    </div>`;
}

function getSelectedHookIds(containerId = 'edit-pattern-hooks-container') {
    return Array.from(document.querySelectorAll(`#${containerId} .hook-select-cb:checked`))
        .map(cb => parseInt(cb.value));
}

// --- Inventory selector helpers ---

function toggleInvDropdown(btn) {
    const dropdown = btn.nextElementSibling;
    const isOpen = dropdown.style.display !== 'none';
    dropdown.style.display = isOpen ? 'none' : '';
    if (!isOpen) {
        btn.textContent = 'Done';
        btn.classList.add('inv-add-btn-open');
        const search = dropdown.querySelector('.inv-selector-search');
        search.value = '';
        filterInvSelector(search);
        search.focus();
    } else {
        btn.textContent = btn.dataset.label;
        btn.classList.remove('inv-add-btn-open');
    }
}

function filterInvSelector(input) {
    const query = input.value.toLowerCase();
    const list = input.nextElementSibling;
    list.querySelectorAll('.inv-brand-group').forEach(group => {
        let anyVisible = false;
        group.querySelectorAll('.inv-selector-item').forEach(item => {
            const text = item.textContent.toLowerCase();
            const brandText = group.querySelector('.inv-brand-label').textContent.toLowerCase();
            const match = !query || text.includes(query) || brandText.includes(query);
            item.style.display = match ? '' : 'none';
            if (match) anyVisible = true;
        });
        group.style.display = anyVisible ? '' : 'none';
    });
}

function toggleInvCheckbox(pill, cbClass) {
    const id = pill.dataset.id;
    const container = pill.closest('.inv-selector');
    const cb = container.querySelector(`.${cbClass}[value="${id}"]`);
    if (cb) {
        cb.checked = false;
        cb.parentElement.classList.remove('selected');
        cb.dispatchEvent(new Event('change'));
    }
}

function updateInvSelectorPills(cb, type) {
    const container = cb.closest('.inv-selector');
    const pillsWrap = container.querySelector('.inv-selected-pills');
    const cbClass = type === 'yarn' ? 'yarn-select-cb' : 'hook-select-cb';
    const items = type === 'yarn' ? yarns : hooks;
    const checked = Array.from(container.querySelectorAll(`.${cbClass}:checked`)).map(c => parseInt(c.value));
    pillsWrap.innerHTML = checked.map(id => {
        const item = items.find(i => i.id === id);
        if (!item) return '';
        const label = type === 'yarn'
            ? ([item.name, item.color].filter(Boolean).join(' - ') || item.brand || 'Unnamed')
            : ([item.name, item.size_label].filter(Boolean).join(' - ') || item.brand || 'Unnamed');
        return `<span class="inv-selected-pill" data-id="${id}" onclick="toggleInvCheckbox(this, '${cbClass}')">${escapeHtml(label)} ×</span>`;
    }).join('');
}

function autoSaveInventoryLinks(cb) {
    const tabContent = cb.closest('.edit-modal-tab-content');
    if (!tabContent) return;
    const modal = tabContent.id.replace('-tab-inventory', '');
    const prefix = modal === 'edit' ? 'edit-pattern' : modal;
    const patternId = modal === 'edit' ? editingPatternId : currentPattern?.id;
    if (!patternId) return;
    const yarnIds = Array.from(document.querySelectorAll(`#${prefix}-yarns-container .yarn-select-cb:checked`)).map(c => parseInt(c.value));
    const hookIds = Array.from(document.querySelectorAll(`#${prefix}-hooks-container .hook-select-cb:checked`)).map(c => parseInt(c.value));
    fetch(`${API_URL}/api/patterns/${patternId}/yarns`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yarnIds })
    });
    fetch(`${API_URL}/api/patterns/${patternId}/hooks`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hookIds })
    });
}

// --- Inventory sorting ---

function sortInventory(items, sortState) {
    const { col, dir } = sortState;
    const numericCols = ['quantity', 'pattern_count', 'size_mm', 'rating'];
    const weightOrder = ['Lace', 'Super Fine', 'Fine', 'Light', 'Medium', 'Bulky', 'Super Bulky', 'Jumbo'];
    return [...items].sort((a, b) => {
        let va = a[col], vb = b[col];
        if (col === 'weight_category') {
            va = weightOrder.indexOf(va);
            vb = weightOrder.indexOf(vb);
            if (va === -1) va = 99;
            if (vb === -1) vb = 99;
        } else if (numericCols.includes(col)) {
            va = parseFloat(va) || 0;
            vb = parseFloat(vb) || 0;
        } else if (col === 'created_at') {
            va = va ? new Date(va).getTime() : 0;
            vb = vb ? new Date(vb).getTime() : 0;
        } else {
            va = (va || '').toString().toLowerCase();
            vb = (vb || '').toString().toLowerCase();
        }
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
    });
}

function toggleYarnSort(col) {
    if (col === 'thumbnail') return;
    if (yarnSort.col === col) {
        yarnSort.dir = yarnSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        yarnSort.col = col;
        yarnSort.dir = 'asc';
    }
    localStorage.setItem('yarnSort', JSON.stringify(yarnSort));
    syncSettingsToServer();
    displayYarns();
}

function toggleHookSort(col) {
    if (col === 'thumbnail') return;
    if (hookSort.col === col) {
        hookSort.dir = hookSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        hookSort.col = col;
        hookSort.dir = 'asc';
    }
    localStorage.setItem('hookSort', JSON.stringify(hookSort));
    syncSettingsToServer();
    displayHooks();
}

function populateYarnBrandFilter() {
    const select = document.getElementById('yarn-brand-filter');
    if (!select) return;
    const current = select.value;
    const brands = [...new Set(yarns.map(y => y.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">All Brands</option>' + brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    if (current && brands.includes(current)) select.value = current;
}

function populateHookFilters() {
    const brandSelect = document.getElementById('hook-brand-filter');
    if (brandSelect) {
        const current = brandSelect.value;
        const brands = [...new Set(hooks.map(h => h.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        brandSelect.innerHTML = '<option value="all">All Brands</option>' + brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
        if (current && brands.includes(current)) brandSelect.value = current;
    }
    const typeSelect = document.getElementById('hook-type-filter');
    if (typeSelect) {
        const current = typeSelect.value;
        const types = [...new Set(hooks.map(h => h.hook_type).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        typeSelect.innerHTML = '<option value="all">All Types</option>' + types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        if (current && types.includes(current)) typeSelect.value = current;
    }
}

// --- Inventory bulk operations ---

// Card view: library-style click handling (same as pattern cards)
function handleInventoryCardClick(event, type, id) {
    if (inventoryEditMode || selectedYarnIds.size > 0 || selectedHookIds.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        const card = event.currentTarget || event.target.closest('.pattern-card');
        const cb = card ? card.querySelector('.bulk-select-checkbox') : null;
        toggleInventoryCardSelect(type, id, cb || card);
        return;
    }
    if (type === 'yarn') openYarnModal(id);
    else openHookModal(id);
}

function toggleInventoryCardSelect(type, id, el) {
    const set = type === 'yarn' ? selectedYarnIds : selectedHookIds;
    if (set.has(id)) { set.delete(id); } else { set.add(id); }
    const card = el.closest('.pattern-card');
    if (card) card.classList.toggle('bulk-selected', set.has(id));
    updateInventoryBulkBar();
}

let invLongPressTimer = null;
let invLongPressTriggered = false;

function initInventoryCardLongPress(type) {
    const attr = type === 'yarn' ? 'data-yarn-id' : 'data-hook-id';
    document.querySelectorAll(type === 'yarn' ? '.yarn-card' : '.hook-card').forEach(card => {
        const id = parseInt(card.getAttribute(attr));
        if (!id) return;
        card.addEventListener('touchstart', (e) => {
            invLongPressTriggered = false;
            invLongPressTimer = setTimeout(() => {
                invLongPressTriggered = true;
                if (navigator.vibrate) navigator.vibrate(30);
                const cb = card.querySelector('.bulk-select-checkbox');
                toggleInventoryCardSelect(type, id, cb || card);
            }, 500);
        }, { passive: true });
        card.addEventListener('touchend', (e) => {
            clearTimeout(invLongPressTimer);
            if (invLongPressTriggered) e.preventDefault();
        });
        card.addEventListener('touchmove', () => {
            clearTimeout(invLongPressTimer);
        }, { passive: true });
        card.addEventListener('contextmenu', (e) => {
            if (invLongPressTimer || invLongPressTriggered) e.preventDefault();
        });
    });
}

// List view: edit mode toggle reveals checkboxes
let inventoryEditMode = false;

function toggleInventoryEditMode() {
    inventoryEditMode = !inventoryEditMode;
    document.getElementById('inv-edit-btn')?.classList.toggle('active', inventoryEditMode);
    document.getElementById('inv-mobile-edit-btn')?.classList.toggle('active', inventoryEditMode);
    if (!inventoryEditMode) {
        clearInventorySelection();
    }
    displayYarns();
    displayHooks();
}

function exitInventoryEditMode() {
    if (!inventoryEditMode) return;
    inventoryEditMode = false;
    document.getElementById('inv-edit-btn')?.classList.remove('active');
    document.getElementById('inv-mobile-edit-btn')?.classList.remove('active');
    clearInventorySelection();
    displayYarns();
    displayHooks();
}

// List view: row click in edit mode toggles selection
function handleInventoryRowClick(event, type, id) {
    if (inventoryEditMode) {
        event.preventDefault();
        event.stopPropagation();
        const row = event.currentTarget || event.target.closest('tr');
        toggleInventoryRowSelect(type, id, row);
        return;
    }
    if (type === 'yarn') openYarnModal(id);
    else openHookModal(id);
}

function toggleInventoryRowSelect(type, id, row) {
    const set = type === 'yarn' ? selectedYarnIds : selectedHookIds;
    if (set.has(id)) { set.delete(id); } else { set.add(id); }
    if (row) row.classList.toggle('bulk-selected', set.has(id));
    updateInventoryBulkBar();
}

// Shared: also handle direct checkbox click in list rows
function toggleInventorySelect(type, id, el) {
    const set = type === 'yarn' ? selectedYarnIds : selectedHookIds;
    if (set.has(id)) { set.delete(id); } else { set.add(id); }
    const container = el.closest('tr') || el.closest('.pattern-card');
    if (container) container.classList.toggle('bulk-selected', set.has(id));
    updateInventoryBulkBar();
}

function clearInventorySelection() {
    selectedYarnIds.clear();
    selectedHookIds.clear();
    document.querySelectorAll('.inventory-table tr.bulk-selected').forEach(r => r.classList.remove('bulk-selected'));
    document.querySelectorAll('.pattern-card.bulk-selected').forEach(c => {
        if (c.classList.contains('yarn-card') || c.classList.contains('hook-card')) c.classList.remove('bulk-selected');
    });
    updateInventoryBulkBar();
}

function updateInventoryBulkBar() {
    const count = selectedYarnIds.size + selectedHookIds.size;
    let bar = document.getElementById('inventory-bulk-bar');
    if (count === 0) {
        if (bar) bar.style.display = 'none';
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'inventory-bulk-bar';
        bar.className = 'inventory-bulk-bar';
        document.body.appendChild(bar);
    }
    const allFav = [...selectedYarnIds].every(id => yarns.find(y => y.id === id)?.is_favorite) &&
                   [...selectedHookIds].every(id => hooks.find(h => h.id === id)?.is_favorite);
    const ratingStars = [1,2,3,4,5].map(i =>
        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" style="cursor:pointer" onclick="bulkSetInventoryRating(${i})">${STAR_SVG}</svg>`
    ).join('');
    bar.innerHTML = `<span>${count} selected</span>
        <button class="btn btn-sm bulk-fav-btn ${allFav ? 'active' : ''}" onclick="bulkToggleInventoryFavorite(${!allFav})" title="${allFav ? 'Unfavorite' : 'Favorite'}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="${allFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
        </button>
        <span class="bulk-rating-stars" title="Set rating">${ratingStars}</span>
        <button class="btn btn-primary btn-sm" onclick="bulkSetQuantity()">Set Quantity</button>
        <button class="btn btn-danger btn-sm" id="bulk-inv-delete-btn" onclick="bulkDeleteInventory(this)">Delete</button>
        <button class="btn btn-sm btn-secondary" onclick="clearInventorySelection()">Clear</button>`;
    bar.style.display = 'flex';
}

async function bulkDeleteInventory(btn) {
    if (!btn.classList.contains('confirm-danger')) {
        btn.classList.add('confirm-danger');
        btn.textContent = 'Confirm Delete?';
        setTimeout(() => {
            if (btn.classList.contains('confirm-danger')) {
                btn.classList.remove('confirm-danger');
                btn.textContent = 'Delete';
            }
        }, 3000);
        return;
    }
    const yarnIds = Array.from(selectedYarnIds);
    const hookIds = Array.from(selectedHookIds);
    const total = yarnIds.length + hookIds.length;
    if (yarnIds.length) {
        await fetch(`${API_URL}/api/yarns/bulk/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: yarnIds })
        });
    }
    if (hookIds.length) {
        await fetch(`${API_URL}/api/hooks/bulk/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: hookIds })
        });
    }
    clearInventorySelection();
    await Promise.all([loadYarns(), loadHooks()]);
    showToast(`Deleted ${total} item${total > 1 ? 's' : ''}`);
}

async function bulkSetQuantity() {
    const input = prompt('Set quantity for selected items:');
    if (input === null) return;
    const quantity = parseFloat(input);
    if (isNaN(quantity) || quantity < 0) { showToast('Invalid quantity', 'error'); return; }
    const yarnIds = Array.from(selectedYarnIds);
    const hookIds = Array.from(selectedHookIds);
    const total = yarnIds.length + hookIds.length;
    if (yarnIds.length) {
        await fetch(`${API_URL}/api/yarns/bulk/quantity`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: yarnIds, quantity })
        });
    }
    if (hookIds.length) {
        await fetch(`${API_URL}/api/hooks/bulk/quantity`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: hookIds, quantity })
        });
    }
    clearInventorySelection();
    await Promise.all([loadYarns(), loadHooks()]);
    showToast(`Updated quantity on ${total} item${total > 1 ? 's' : ''}`);
}

async function bulkToggleInventoryFavorite(isFavorite) {
    const yarnIds = Array.from(selectedYarnIds);
    const hookIds = Array.from(selectedHookIds);
    const total = yarnIds.length + hookIds.length;
    for (const id of yarnIds) {
        await fetch(`${API_URL}/api/yarns/${id}/favorite`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });
    }
    for (const id of hookIds) {
        await fetch(`${API_URL}/api/hooks/${id}/favorite`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });
    }
    clearInventorySelection();
    await Promise.all([loadYarns(), loadHooks()]);
    showToast(`${isFavorite ? 'Favorited' : 'Unfavorited'} ${total} item${total > 1 ? 's' : ''}`);
}

async function bulkSetInventoryRating(rating) {
    const yarnIds = Array.from(selectedYarnIds);
    const hookIds = Array.from(selectedHookIds);
    const total = yarnIds.length + hookIds.length;
    for (const id of yarnIds) {
        await fetch(`${API_URL}/api/yarns/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        });
    }
    for (const id of hookIds) {
        await fetch(`${API_URL}/api/hooks/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        });
    }
    clearInventorySelection();
    await Promise.all([loadYarns(), loadHooks()]);
    showToast(`Rated ${total} item${total > 1 ? 's' : ''} ${rating} star${rating > 1 ? 's' : ''}`);
}

// --- Linked patterns list (for yarn/hook modals) ---

function renderLinkedPatterns(patterns) {
    if (!patterns.length) return '<p class="text-muted" style="font-size:0.85rem;">No patterns linked.</p>';
    return `<div class="linked-patterns-list">${patterns.map(p => {
        const thumb = p.thumbnail
            ? `<img src="${API_URL}/api/patterns/${p.id}/thumbnail" class="linked-pattern-thumb" alt="">`
            : `<div class="linked-pattern-thumb linked-pattern-thumb-empty"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`;
        return `<div class="linked-pattern-row" onclick="closeYarnModal(); closeHookModal(); openPDFViewer(${p.id})">
            ${thumb}
            <div class="linked-pattern-info">
                <span class="linked-pattern-name">${escapeHtml(p.name)}</span>
                ${p.category ? `<span class="linked-pattern-cat">${escapeHtml(p.category)}</span>` : ''}
            </div>
        </div>`;
    }).join('')}</div>`;
}

// --- Edit modal tab switching ---

function initEditModalTabs() {
    document.querySelectorAll('.edit-modal-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.dataset.modal;
            const tab = btn.dataset.tab;
            // Toggle tab buttons
            document.querySelectorAll(`.edit-modal-tab[data-modal="${modal}"]`).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Toggle all tab content panes for this modal
            document.querySelectorAll(`[id^="${modal}-tab-"]`).forEach(el => {
                const paneTab = el.id.replace(`${modal}-tab-`, '');
                el.classList.toggle('active', paneTab === tab);
            });
        });
    });
}

function resetEditModalTab(modal) {
    document.querySelectorAll(`.edit-modal-tab[data-modal="${modal}"]`).forEach(b => {
        b.classList.toggle('active', b.dataset.tab === 'details');
    });
    document.querySelectorAll(`[id^="${modal}-tab-"]`).forEach(el => {
        const paneTab = el.id.replace(`${modal}-tab-`, '');
        el.classList.toggle('active', paneTab === 'details');
    });
}

function updateInventoryTabBadge(modal) {
    const btn = document.querySelector(`.edit-modal-tab[data-modal="${modal}"][data-tab="inventory"]`);
    if (!btn) return;
    const prefix = modal === 'edit' ? 'edit-pattern' : modal;
    const yarnCount = document.querySelectorAll(`#${prefix}-yarns-container .yarn-select-cb:checked`).length;
    const hookCount = document.querySelectorAll(`#${prefix}-hooks-container .hook-select-cb:checked`).length;
    const total = yarnCount + hookCount;
    btn.textContent = total > 0 ? `Inventory (${total})` : 'Inventory';
}

function updateInventoryBadgeFromCheckbox(cb) {
    const tabContent = cb.closest('.edit-modal-tab-content');
    if (!tabContent) return;
    const modal = tabContent.id.replace('-tab-inventory', '');
    updateInventoryTabBadge(modal);
}
