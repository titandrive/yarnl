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
    'showCategoryBadge', 'showStarBadge',
    'librarySort', 'libraryShowCompleted', 'libraryShowCurrent',
    'libraryShowPdf', 'libraryShowMarkdown', 'libraryHighlightMode',
    'libraryPinCurrent', 'libraryPinFavorites', 'libraryShowFilter',
    'libraryCategoryFilter',
    // Navigation & PDF
    'defaultPage', 'defaultPdfZoom', 'pdfScrollMode', 'arrowKeysScroll',
    'scrollPageButtons',
    // Projects
    'projectSort', 'projectShowFilter',
    // Behavior
    'autoCurrentOnTimer', 'autoTimerDefault', 'defaultCategory',
    'enableDirectDelete', 'hapticFeedback', 'wakeLock', 'keyboardShortcuts',
    // Notes
    'notesLivePreview', 'notesPopoverSize',
    // Media
    'mediaRemoteEnabled',
    // Backup
    'backupScheduleEnabled', 'backupSchedule',
    'backupPruneEnabled', 'backupPruneMode',
    'backupPruneValue', 'backupTime'
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
            await Promise.all([loadPatterns(), loadProjects()]);
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
    } catch (error) {
        console.error('Failed to load account info:', error);
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
let autoCurrentOnTimer = localStorage.getItem('autoCurrentOnTimer') === 'true';
let autoTimerDefault = localStorage.getItem('autoTimerDefault') === 'true';
let autoTimerEnabled = false;
let autoTimerPausedInactive = false;
let inactivityTimeout = null;
const INACTIVITY_DELAY = 5 * 60 * 1000; // 5 minutes
let defaultCategory = localStorage.getItem('defaultCategory') || 'Amigurumi';
let enableDirectDelete = localStorage.getItem('enableDirectDelete') === 'true';

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
            inactivityTimeout = setTimeout(() => {
                if (autoTimerEnabled && timerRunning) {
                    autoTimerPausedInactive = true;
                    stopTimer();
                    updateAutoTimerButtonState();
                }
            }, INACTIVITY_DELAY);
        }
    };

    // Listen for user activity
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(event => {
        document.addEventListener(event, resetInactivity, { passive: true });
    });

    // Save timer when page is hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && timerRunning) {
            stopTimer(true);
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
        inactivityTimeout = setTimeout(() => {
            if (autoTimerEnabled && timerRunning) {
                autoTimerPausedInactive = true;
                stopTimer();
                updateAutoTimerButtonState();
            }
        }, INACTIVITY_DELAY);
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
    console.log('loadPatternTimer called, pattern.timer_seconds:', pattern.timer_seconds);
    timerSeconds = pattern.timer_seconds || 0;
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
    appInitialized = true;
    await Promise.all([loadPatterns(), loadProjects()]);
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
            if (pattern) {
                await openPDFViewer(pattern.id, false);
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
    textarea.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();

                const file = item.getAsFile();
                if (!file) return;

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
        { id: 'forest', name: 'Forest', primary: '#4ade80', secondary: '#a3e635' },
        { id: 'rose', name: 'Rose', primary: '#fb7185', secondary: '#db2777' },
        { id: 'slate', name: 'Slate', primary: '#818cf8', secondary: '#94a3b8' },
        { id: 'aqua', name: 'Aqua', primary: '#22d3ee', secondary: '#2dd4bf' },
        // { id: 'coffee', name: 'Coffee', primary: '#c9a26d', secondary: '#d4a574' },
        { id: 'nasa', name: 'NASA', primary: '#105bd8', secondary: '#0b3d91' },
        { id: 'minimal', name: 'Minimal', primary: '#9ca3af', secondary: '#d1d5db' },
    ],
    darkOnly: [
        { id: 'synthwave', name: 'Synthwave', primary: '#e879f9', secondary: '#22d3ee' },
        { id: 'dracula', name: 'Dracula', primary: '#bd93f9', secondary: '#44475a' },
        { id: 'midnight', name: 'Midnight', primary: '#ef4444', secondary: '#f97316' },
        { id: 'cyberpunk', name: 'Cyberpink', primary: '#ff00ff', secondary: '#00f0ff' },
        { id: 'halloween', name: 'Halloween', primary: '#f97316', secondary: '#22c55e' },
        { id: 'sunset', name: 'Sunset', primary: '#fb923c', secondary: '#facc15' },
        { id: 'razer', name: 'Razer', primary: '#00ff00', secondary: '#141414' },
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
        if (themeModeLightBtn && themeModeDarkBtn) {
            const isDarkOnly = DARK_ONLY_IDS.has(themeBase);
            themeModeLightBtn.classList.toggle('active', currentEffective === 'light' && !isDarkOnly);
            themeModeLightBtn.classList.toggle('disabled', isDarkOnly);
            themeModeLightBtn.disabled = isDarkOnly;
            themeModeDarkBtn.classList.toggle('active', currentEffective === 'dark' || isDarkOnly);
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
            }
        });
    }
    if (closeThemeModalBtn && themeModal) {
        closeThemeModalBtn.addEventListener('click', () => {
            themeModal.style.display = 'none';
            document.body.style.overflow = '';
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
        headerThemeToggle.style.display = showHeaderThemeToggle ? 'flex' : 'none';

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
                headerThemeToggle.style.display = show ? 'flex' : 'none';
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
            if (typeBadgeCheckbox) typeBadgeCheckbox.checked = true;
            if (statusBadgeCheckbox) statusBadgeCheckbox.checked = true;
            if (categoryBadgeCheckbox) categoryBadgeCheckbox.checked = true;
            displayPatterns();

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

            showToast('Settings reset to defaults');
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

    const tabOrder = ['current', 'library', 'projects'];
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
        // Don't swipe inside PDF viewer or modals
        if (e.target.closest('#pdf-viewer-container, .modal, .settings-content')) return;
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

    // Hide PDF viewer, markdown viewer, and project detail
    pdfViewerContainer.style.display = 'none';
    const markdownViewer = document.getElementById('markdown-viewer-container');
    if (markdownViewer) markdownViewer.style.display = 'none';
    const projectDetail = document.getElementById('project-detail-view');
    if (projectDetail) projectDetail.style.display = 'none';
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
        if (pattern) {
            await openPDFViewer(pattern.id, pushHistory);
        }
    } else if (view.startsWith('project/')) {
        const projectId = parseInt(view.split('/')[1]);
        if (projectId) {
            await openProjectView(projectId);
        }
    } else if (view.startsWith('settings/')) {
        const section = view.split('/')[1];
        switchToTab('settings', false);
        switchToSettingsSection(section, pushHistory);
    } else {
        switchToTab(view, pushHistory);
    }
}

function updateSettingsButton(inSettings) {
    const settingsBtn = document.getElementById('settings-btn');
    if (!settingsBtn) return;

    const svg = settingsBtn.querySelector('svg');
    const label = settingsBtn.querySelector('span');

    if (inSettings) {
        // Change to back button
        svg.innerHTML = '<path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
        label.textContent = 'Back';
        settingsBtn.setAttribute('aria-label', 'Back');
    } else {
        // Change to settings button
        svg.innerHTML = '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>';
        label.textContent = 'Settings';
        settingsBtn.setAttribute('aria-label', 'Settings');
    }
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
            showToast(showStarBadge ? 'Star badge shown' : 'Star badge hidden');
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
    if (section === 'archive') {
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

function toggleNewPatternLivePreview(enabled) {
    const editorWrapper = document.querySelector('.new-pattern-editor-wrapper');
    const tabs = document.querySelectorAll('.new-pattern-tab');

    // Remove all mode classes
    editorWrapper.classList.remove('edit-mode', 'preview-mode', 'live-preview-mode');

    if (enabled) {
        // Enable live preview - show both panes
        editorWrapper.classList.add('live-preview-mode');
        // Hide tabs when in live preview
        tabs.forEach(tab => tab.style.display = 'none');
        updateNewPatternPreview();
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
            ${showTypeBadge ? `<span class="type-badge">${typeLabel}</span>` : ''}
            ${isOwnPattern && showStarBadge && pattern.is_favorite ? '<span class="favorite-badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></span>' : ''}
            ${!isOwnPattern && ownerName ? `<span class="owner-badge-overlay" style="background:${userColor(ownerName)}">${escapeHtml(ownerName)}</span>` : ''}
            ${pattern.thumbnail
                ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" class="pattern-thumbnail" alt="${escapeHtml(pattern.name)}">`
                : `<div class="pattern-thumbnail-placeholder">
                    <svg viewBox="0 0 100 100" width="80" height="80">
                        <circle cx="50" cy="50" r="35" fill="none" stroke="currentColor" stroke-width="3"/>
                        <ellipse cx="50" cy="50" rx="35" ry="12" fill="none" stroke="currentColor" stroke-width="2"/>
                        <ellipse cx="50" cy="50" rx="35" ry="12" fill="none" stroke="currentColor" stroke-width="2" transform="rotate(60 50 50)"/>
                        <ellipse cx="50" cy="50" rx="35" ry="12" fill="none" stroke="currentColor" stroke-width="2" transform="rotate(120 50 50)"/>
                    </svg>
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
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
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
    filteredPatterns = [...filteredPatterns].sort((a, b) => {
        // Pin favorites/current to top first
        if (pinFavorites && a.is_favorite !== b.is_favorite) {
            return b.is_favorite ? 1 : -1;
        }
        if (pinCurrent && a.is_current !== b.is_current) {
            return b.is_current ? 1 : -1;
        }

        // Then apply selected sort
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
            default:
                return 0;
        }
    });

    if (filteredPatterns.length === 0) {
        grid.innerHTML = `<p class="empty-state">No patterns match the current filters</p>`;
        return;
    }

    grid.innerHTML = filteredPatterns.map(pattern => {
        const isNewPattern = !pattern.completed && !pattern.timer_seconds;
        const shouldHighlight = (highlightMode === 'new' && isNewPattern) || (highlightMode === 'current' && pattern.is_current) || (highlightMode === 'favorites' && pattern.is_favorite);
        const highlightClass = shouldHighlight ? ' highlight-new' : '';
        return renderPatternCard(pattern, { highlightClass });
    }).join('');
    grid.querySelectorAll('.pattern-card[data-pattern-id]').forEach(initLongPress);
}

async function toggleCurrent(id, isCurrent) {
    // Optimistic update
    const pattern = patterns.find(p => String(p.id) === String(id));
    if (pattern) {
        pattern.is_current = isCurrent;
        // Also update currentPatterns array so the In Progress page reflects the change
        if (isCurrent) {
            if (!currentPatterns.find(p => String(p.id) === String(id))) {
                currentPatterns.push(pattern);
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
    if (pattern) {
        pattern.is_favorite = isFavorite;
        displayCurrentPatterns();
        displayPatterns();
    }
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

async function deletePattern(id) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            await loadPatterns();
            await loadCurrentPatterns();
            await loadCategories();
        } else {
            const error = await response.json();
            console.error('Error deleting pattern:', error.error);
        }
    } catch (error) {
        console.error('Error deleting pattern:', error);
    }
}

async function archivePattern(id) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/archive`, {
            method: 'POST'
        });

        if (response.ok) {
            showToast('Pattern archived');
            await loadPatterns();
            await loadCurrentPatterns();
            await loadCategories();
            await loadArchivedPatternsUI();
        } else {
            const error = await response.json();
            console.error('Error archiving pattern:', error.error);
            showToast('Error archiving pattern', 'error');
        }
    } catch (error) {
        console.error('Error archiving pattern:', error);
        showToast('Error archiving pattern', 'error');
    }
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
    const isMobileViewport = () => window.matchMedia('(max-width: 768px)').matches;

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

    // Pattern Info modal buttons
    document.getElementById('close-pattern-info-modal').addEventListener('click', closePatternInfoModal);
    document.getElementById('close-pattern-info-btn').addEventListener('click', closePatternInfoModal);

    // Notes auto-save on input
    const notesEditor = document.getElementById('notes-editor');
    notesEditor.addEventListener('input', scheduleNotesAutoSave);
    // Enable auto-continue for lists
    setupMarkdownListContinuation(notesEditor);

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
    document.querySelectorAll('.pattern-card.bulk-selected').forEach(c => c.classList.remove('bulk-selected'));
    updateBulkToolbar();
}

function updateBulkToolbar() {
    const toolbar = document.getElementById('bulk-toolbar');
    if (!toolbar) return;
    if (selectedPatternIds.size > 0) {
        toolbar.style.display = 'flex';
        document.getElementById('bulk-count').textContent = `${selectedPatternIds.size} selected`;
    } else {
        toolbar.style.display = 'none';
    }
}

// Escape key clears bulk selection
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedPatternIds.size > 0) {
        clearBulkSelection();
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

    document.getElementById('bulk-edit-modal').style.display = 'flex';
}

function closeBulkEditModal() {
    document.getElementById('bulk-edit-modal').style.display = 'none';
}

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

        // Initialize auto timer based on default setting
        autoTimerEnabled = autoTimerDefault;
        autoTimerPausedInactive = false;
        updateAutoTimerButtonState();
        if (autoTimerEnabled) {
            // Start timer and inactivity tracking
            startTimer();
            if (inactivityTimeout) clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => {
                if (autoTimerEnabled && timerRunning) {
                    autoTimerPausedInactive = true;
                    stopTimer();
                    updateAutoTimerButtonState();
                }
            }, INACTIVITY_DELAY);
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

        const pdfUrl = `${API_URL}/api/patterns/${pattern.id}/file`;
        const isMobile = window.matchMedia('(max-width: 768px)').matches;

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
        const encodedUrl = encodeURIComponent(pdfUrl);
        pdfIframe.src = `/pdfjs/web/viewer.html?file=${encodedUrl}#page=${currentPageNum}&pagemode=none`;

        // Configure viewer and track page changes via PDF.js API
        pdfIframe.addEventListener('load', () => {
            const viewerApp = pdfIframe.contentWindow?.PDFViewerApplication;
            if (!viewerApp) return;
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
                    await fetch(`${API_URL}/api/patterns/${patternId}/file`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/pdf' },
                        body: data
                    });
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
                                clearTimeout(annotationSaveTimer);
                                annotationSaveTimer = setTimeout(saveAnnotations, 2000);
                            };
                        }
                    }, 500);
                });

                // Also catch annotation changes via eventBus as a backup
                viewerApp.eventBus.on('annotationeditorstateschanged', (evt) => {
                    if (evt.details?.hasSomethingToUndo) {
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
        pdfObject.remove();
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
            saveTimerImmediate().catch(() => {});
        }
        if (closingPage) {
            fetch(`${API_URL}/api/patterns/${closingPattern.id}/page`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPage: closingPage })
            }).catch(() => {});
        }
        if (annotationData) {
            fetch(`${API_URL}/api/patterns/${closingPattern.id}/file`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/pdf' },
                body: annotationData
            }).catch(() => {});
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

    // Set existing thumbnail in selector
    if (currentPattern.thumbnail) {
        setThumbnailSelectorImage('pdf-edit', `${API_URL}${currentPattern.thumbnail}`);
    } else {
        clearThumbnailSelector('pdf-edit');
    }

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
            { label: 'Type', value: info.pattern_type === 'markdown' ? 'Markdown' : 'PDF' },
            { label: 'Date Added', value: new Date(info.upload_date).toLocaleDateString() },
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

    if (!name.trim()) {
        alert('Pattern name is required');
        return;
    }

    try {
        // Update pattern metadata
        const metaResponse = await fetch(`${API_URL}/api/patterns/${currentPattern.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, description })
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

function displayCounters() {
    const countersList = document.getElementById('counters-list');

    if (counters.length === 0) {
        countersList.innerHTML = '<p style="text-align: center; color: #6b7280;">No counters. Click + to create one.</p>';
        return;
    }

    countersList.innerHTML = counters.map(counter => `
        <div class="counter-item${lastUsedCounterId === counter.id ? ' active' : ''}" data-counter-id="${counter.id}" onclick="selectCounter(${counter.id})">
            <div class="counter-name">
                <input type="text" value="${escapeHtml(counter.name)}"
                       onchange="updateCounterName(${counter.id}, this.value)"
                       onkeydown="if(event.key==='Enter'){this.blur()}"
                       onclick="event.stopPropagation(); selectCounter(${counter.id})"
                       onfocus="selectCounter(${counter.id})"
                       placeholder="Counter name">
            </div>
            <div class="counter-value">${counter.value}</div>
            <div class="counter-controls">
                <button class="counter-btn counter-btn-minus" onclick="event.stopPropagation(); selectCounter(${counter.id}); decrementCounter(${counter.id})">−</button>
                <button class="counter-btn counter-btn-plus" onclick="event.stopPropagation(); selectCounter(${counter.id}); incrementCounter(${counter.id})">+</button>
                <button class="counter-btn counter-btn-reset" onclick="selectCounter(${counter.id}); handleCounterReset(event, ${counter.id})" title="Click twice to reset">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                        <path d="M3 3v5h5"/>
                    </svg>
                </button>
                <button class="counter-btn counter-btn-delete" onclick="selectCounter(${counter.id}); handleCounterDelete(event, ${counter.id})" title="Click twice to delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    mobileBar.update();
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

    function isMobile() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function update() {
        const bar = document.getElementById('mobile-bottom-bar');
        if (!bar || !isMobile()) return;

        const counterSection = bar.querySelector('.mobile-bar-counter');
        const addBtn = bar.querySelector('.mobile-counter-add');
        const divider = bar.querySelector('.mobile-bar-divider');

        if (counters.length === 0) {
            if (counterSection) counterSection.style.display = 'none';
            if (addBtn) addBtn.style.display = '';
            if (divider) divider.style.display = 'none';
            return;
        }

        if (counterSection) counterSection.style.display = '';
        if (addBtn) addBtn.style.display = 'none';
        if (divider) divider.style.display = '';

        // Clamp index
        if (currentIndex >= counters.length) currentIndex = counters.length - 1;
        if (currentIndex < 0) currentIndex = 0;

        // Sync with active counter
        const activeIdx = counters.findIndex(c => c.id === lastUsedCounterId);
        if (activeIdx >= 0) currentIndex = activeIdx;

        const counter = counters[currentIndex];

        bar.querySelector('.mobile-counter-name').textContent = counter.name || 'Counter';
        bar.querySelector('.mobile-counter-value').textContent = counter.value;

        // Show/hide nav arrows
        const prev = bar.querySelector('.mobile-counter-prev');
        const next = bar.querySelector('.mobile-counter-next');
        if (prev) prev.classList.toggle('hidden', counters.length <= 1);
        if (next) next.classList.toggle('hidden', counters.length <= 1);

        // Update page info
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
        if (counters.length <= 1) return;
        currentIndex = (currentIndex + delta + counters.length) % counters.length;
        lastUsedCounterId = counters[currentIndex].id;
        displayCounters();
        update();
    }

    function toggleEdit(show) {
        const bar = document.getElementById('mobile-bottom-bar');
        if (!bar) return;
        const editPanel = bar.querySelector('.mobile-bar-edit');
        if (show) {
            const counter = counters[currentIndex];
            if (!counter) return;
            bar.querySelector('.mobile-edit-name').value = counter.name || '';
            bar.querySelector('.mobile-edit-pos').textContent = `${currentIndex + 1} / ${counters.length}`;
            editPanel.style.display = '';
        } else {
            // Save name if changed before closing
            const nameInput = bar.querySelector('.mobile-edit-name');
            const counter = counters[currentIndex];
            if (counter && nameInput.value !== counter.name) {
                counter.name = nameInput.value;
                updateCounterName(counter.id, nameInput.value);
            }
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

            // Counter navigation
            bar.querySelector('.mobile-counter-prev').addEventListener('click', () => nav(-1));
            bar.querySelector('.mobile-counter-next').addEventListener('click', () => nav(1));

            // Counter increment/decrement
            bar.querySelector('.mobile-counter-inc').addEventListener('click', () => {
                if (counters[currentIndex]) incrementCounter(counters[currentIndex].id);
            });
            bar.querySelector('.mobile-counter-dec').addEventListener('click', () => {
                if (counters[currentIndex]) decrementCounter(counters[currentIndex].id);
            });

            // Counter label tap → edit
            bar.querySelector('.mobile-bar-counter-label').addEventListener('click', () => {
                if (counters.length > 0) toggleEdit(true);
            });

            // Edit panel
            bar.querySelector('.mobile-edit-done').addEventListener('click', () => toggleEdit(false));
            bar.querySelector('.mobile-edit-add').addEventListener('click', async () => {
                await addCounter('Counter');
                toggleEdit(false);
            });
            bar.querySelector('.mobile-edit-reset').addEventListener('click', async () => {
                const counter = counters[currentIndex];
                if (!counter) return;
                await resetCounter(counter.id);
                update();
            });
            bar.querySelector('.mobile-edit-delete').addEventListener('click', async () => {
                const counter = counters[currentIndex];
                if (!counter) return;
                await deleteCounter(counter.id);
                if (counters.length === 0) {
                    toggleEdit(false);
                } else {
                    update();
                    toggleEdit(true);
                }
            });
            bar.querySelector('.mobile-edit-name').addEventListener('change', (e) => {
                const counter = counters[currentIndex];
                if (counter) updateCounterName(counter.id, e.target.value);
            });
            bar.querySelector('.mobile-edit-prev').addEventListener('click', () => {
                nav(-1);
                toggleEdit(true);
            });
            bar.querySelector('.mobile-edit-next').addEventListener('click', () => {
                nav(1);
                toggleEdit(true);
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

async function incrementCounter(counterId) {
    try {
        lastUsedCounterId = counterId;
        const response = await fetch(`${API_URL}/api/counters/${counterId}/increment`, {
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
            const updated = await response.json();
            const counter = counters.find(c => c.id === counterId);
            if (counter) {
                counter.value = updated.value;
                displayCounters();
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
        deleteCounter(counterId);
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

function toggleLivePreview() {
    const checkbox = document.getElementById('notes-live-preview');
    const body = document.querySelector('.notes-popover-body');
    const tabs = document.querySelector('.notes-tabs');

    localStorage.setItem('notesLivePreview', checkbox.checked);

    if (checkbox.checked) {
        body.classList.add('live-preview');
        tabs.style.display = 'none';
        updateLivePreview();
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

async function deleteEditPattern() {
    if (!editingPatternId) return;

    if (!confirm('Are you sure you want to delete this pattern?')) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/patterns/${editingPatternId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            closeEditModal();
            await loadPatterns();
            await loadCurrentPatterns();
            await loadCategories();
        } else {
            const error = await response.json();
            console.error('Error deleting pattern:', error.error);
        }
    } catch (error) {
        console.error('Error deleting pattern:', error);
    }
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

    // Set current toggle state
    document.getElementById('edit-is-current').checked = pattern.is_current || false;

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
        const response = await fetch(`${API_URL}/api/patterns/${editingPatternId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, description })
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

        // Initialize auto timer based on default setting
        autoTimerEnabled = autoTimerDefault;
        autoTimerPausedInactive = false;
        updateAutoTimerButtonState();
        if (autoTimerEnabled) {
            // Start timer and inactivity tracking
            startTimer();
            if (inactivityTimeout) clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => {
                if (autoTimerEnabled && timerRunning) {
                    autoTimerPausedInactive = true;
                    stopTimer();
                    updateAutoTimerButtonState();
                }
            }, INACTIVITY_DELAY);
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
    livePreviewCheckbox.onchange = (e) => {
        if (e.target.checked) {
            switchMarkdownNotesTab('preview');
        }
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

    contentEl.style.display = 'block';
    editorEl.style.display = 'none';
    wrapper.classList.remove('editing');
    if (toggleBtn) {
        toggleBtn.classList.remove('active');
        toggleBtn.querySelector('span').textContent = 'Edit';
    }
}

function handleInlineEditorInput() {
    markdownInlineEditorDirty = true;
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
        document.getElementById('markdown-notes-preview').innerHTML = renderMarkdown(editor.value);
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
function openMarkdownEditModal() {
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

    // Set existing thumbnail in selector
    if (currentPattern.thumbnail) {
        setThumbnailSelectorImage('markdown-edit', `${API_URL}${currentPattern.thumbnail}`);
    } else {
        clearThumbnailSelector('markdown-edit');
    }

    // Set current toggle state
    document.getElementById('markdown-edit-is-current').checked = currentPattern.is_current || false;

    // Reset delete button state
    const deleteBtn = document.getElementById('delete-markdown-pattern');
    resetDeleteButton(deleteBtn, 'Delete Pattern');

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

    if (!name.trim()) {
        alert('Pattern name is required');
        return;
    }

    try {
        // Update pattern metadata
        const metaResponse = await fetch(`${API_URL}/api/patterns/${currentPattern.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, description })
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
            ${project.is_favorite ? '<span class="favorite-badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></span>' : ''}

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
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
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
                        ${pattern.is_favorite ? '<span class="peg-favorite"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></span>' : ''}
                        <span class="peg-type">${typeLabel}</span>
                        ${pattern.thumbnail
                            ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" alt="">`
                            : `<div class="peg-placeholder">
                                   <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                       <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                       <polyline points="14 2 14 8 20 8"></polyline>
                                   </svg>
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
