// API base URL
const API_URL = '';

// State
let patterns = [];
let currentPatterns = [];
let allCategories = []; // All possible categories for editing/uploading
let populatedCategories = []; // Only categories with patterns (for filtering)
let allHashtags = []; // All available hashtags
let selectedFile = null;
let editingPatternId = null;
let stagedFiles = []; // Array to hold staged files with metadata
let selectedCategoryFilter = 'all';
let selectedSort = 'date-desc';
let showCompleted = true;
let showCurrent = true;
let searchQuery = '';
let previousTab = 'current';
let showTabCounts = localStorage.getItem('showTabCounts') !== 'false';

// PDF Viewer State
let pdfDoc = null;
let currentPageNum = 1;
let totalPages = 0;
let currentPattern = null;
let counters = [];
let lastUsedCounterId = null;

// PDF.js configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const pdfViewerContainer = document.getElementById('pdf-viewer-container');
const pdfCanvas = document.getElementById('pdf-canvas');

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initTabs();
    initUpload();
    initEditModal();
    initPDFViewer();
    initLibraryFilters();
    initSettings();
    initAddMenu();
    initNewPatternPanel();
    loadPatterns();
    loadCurrentPatterns();
    loadCategories();
    loadHashtags();
});

// Theme toggle
function initTheme() {
    const themeCheckbox = document.getElementById('theme-toggle-checkbox');

    const currentTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);

    // Set checkbox state (checked = light mode)
    if (themeCheckbox) {
        themeCheckbox.checked = currentTheme === 'light';

        themeCheckbox.addEventListener('change', () => {
            const newTheme = themeCheckbox.checked ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }
}

// Tab switching
function initTabs() {
    // Restore last active tab from localStorage
    const lastActiveTab = localStorage.getItem('activeTab') || 'current-patterns';
    switchToTab(lastActiveTab);

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            switchToTab(tabName);
            // Save active tab to localStorage
            localStorage.setItem('activeTab', tabName);
        });
    });
}

function switchToTab(tabName) {
    // Track previous tab (but not if switching to settings)
    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (currentTab && tabName === 'settings') {
        previousTab = currentTab;
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

    // Hide PDF viewer
    pdfViewerContainer.style.display = 'none';
}

// Upload functionality
function initUpload() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const uploadAllBtn = document.getElementById('upload-all-btn');
    const clearAllBtn = document.getElementById('clear-all-btn');

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

    // Drag and drop - handle multiple files
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        if (files.length > 0) {
            handleFiles(files);
        }
    });

    // Upload all button
    uploadAllBtn.addEventListener('click', () => uploadAllPatterns());

    // Clear all button
    clearAllBtn.addEventListener('click', () => clearAllStaged());
}

function handleFiles(files) {
    // Filter only PDF files
    const pdfFiles = files.filter(f => f.type === 'application/pdf');

    if (pdfFiles.length === 0) {
        return;
    }

    // Add files to staging area
    pdfFiles.forEach(file => {
        const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const stagedFile = {
            id: fileId,
            file: file,
            name: file.name.replace('.pdf', ''),
            category: 'Amigurumi',
            description: '',
            hashtagIds: [],
            isCurrent: false,
            status: 'staged', // staged, uploading, success, error
            progress: 0,
            error: null
        };
        stagedFiles.push(stagedFile);
    });

    renderStagedFiles();
    showStagingArea();
}

function showStagingArea() {
    const stagingArea = document.getElementById('staging-area');
    stagingArea.style.display = 'block';
    updateStagedCount();
}

function hideStagingArea() {
    const stagingArea = document.getElementById('staging-area');
    stagingArea.style.display = 'none';
}

function updateStagedCount() {
    const countElement = document.getElementById('staged-count');
    countElement.textContent = stagedFiles.length;
}

function renderStagedFiles() {
    const container = document.getElementById('staged-files-list');

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

        return `
            <div class="staged-file-item ${statusClass}" data-file-id="${stagedFile.id}">
                <div class="staged-file-header">
                    <div class="staged-file-info">
                        <div class="staged-file-name">${escapeHtml(stagedFile.file.name)}</div>
                        <div class="staged-file-size">${fileSize} MB</div>
                    </div>
                    <button class="staged-file-remove" onclick="removeStagedFile('${stagedFile.id}')"
                            ${isUploading ? 'disabled' : ''}>
                        Remove
                    </button>
                </div>

                <div class="staged-file-form">
                    <div class="form-group">
                        <label>Pattern Name</label>
                        <input type="text"
                               value="${escapeHtml(stagedFile.name)}"
                               oninput="updateStagedFile('${stagedFile.id}', 'name', this.value)"
                               ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>
                    </div>
                    <div class="form-group">
                        <label>Category</label>
                        ${createCategoryDropdown(`staged-${stagedFile.id}`, stagedFile.category, isUploading || stagedFile.status === 'success')}
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea rows="2"
                                  onchange="updateStagedFile('${stagedFile.id}', 'description', this.value)"
                                  ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>${escapeHtml(stagedFile.description)}</textarea>
                    </div>
                    <div class="form-group">
                        <label>Hashtags</label>
                        ${createHashtagSelector(`staged-${stagedFile.id}`, stagedFile.hashtagIds || [], isUploading || stagedFile.status === 'success')}
                    </div>
                    <div class="form-group checkbox-group">
                        <label>
                            <input type="checkbox"
                                   ${stagedFile.isCurrent ? 'checked' : ''}
                                   onchange="updateStagedFile('${stagedFile.id}', 'isCurrent', this.checked)"
                                   ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>
                            Mark as current pattern
                        </label>
                    </div>
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

function clearAllStaged() {
    // Only clear staged and error files, not uploading or success
    const canClear = stagedFiles.filter(f => f.status === 'staged' || f.status === 'error');
    if (canClear.length === 0) {
        return;
    }

    if (confirm(`Clear ${canClear.length} file(s)?`)) {
        stagedFiles = stagedFiles.filter(f => f.status === 'uploading' || f.status === 'success');
        if (stagedFiles.length === 0) {
            hideStagingArea();
        } else {
            renderStagedFiles();
        }
    }
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

    // Reload patterns and categories after all uploads
    await loadPatterns();
    await loadCurrentPatterns();
    await loadCategories();

    // Remove successful uploads after a delay
    setTimeout(() => {
        stagedFiles = stagedFiles.filter(f => f.status !== 'success');
        if (stagedFiles.length === 0) {
            hideStagingArea();
        } else {
            renderStagedFiles();
        }
    }, 2000);
}

async function uploadStagedFile(stagedFile) {
    stagedFile.status = 'uploading';
    stagedFile.progress = 0;
    stagedFile.error = null;

    // Get current hashtag selections before rendering (which might reset them)
    const hashtagIds = getSelectedHashtagIds(`staged-${stagedFile.id}`);
    stagedFile.hashtagIds = hashtagIds;

    renderStagedFiles();

    const formData = new FormData();
    formData.append('pdf', stagedFile.file);
    formData.append('name', stagedFile.name || stagedFile.file.name.replace('.pdf', ''));
    formData.append('category', stagedFile.category);
    formData.append('description', stagedFile.description);
    formData.append('isCurrent', stagedFile.isCurrent);

    try {
        const xhr = new XMLHttpRequest();

        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = (e.loaded / e.total) * 100;
                stagedFile.progress = Math.round(percentComplete);
                renderStagedFiles();
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
        renderStagedFiles();

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
        displayPatterns();
        updateTabCounts();
    } catch (error) {
        console.error('Error loading patterns:', error);
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
    const selected = selectedCategory || allCategories[0] || '';
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
                    <input type="text" placeholder="Add new..."
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
            switchToTab('settings');
            loadLibraryStats();
        });
    }

    if (settingsBackBtn) {
        settingsBackBtn.addEventListener('click', () => {
            switchToTab(previousTab);
        });
    }

    if (tabCountsCheckbox) {
        tabCountsCheckbox.checked = showTabCounts;
        tabCountsCheckbox.addEventListener('change', () => {
            showTabCounts = tabCountsCheckbox.checked;
            localStorage.setItem('showTabCounts', showTabCounts);
            updateTabCounts();
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
        categoryContainer.innerHTML = createCategoryDropdown('new-pattern-category', 'Amigurumi');
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
    document.getElementById('new-pattern-thumbnail').value = '';
    document.getElementById('new-pattern-preview').innerHTML = '<p style="color: var(--text-muted);">Preview will appear here...</p>';

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

async function saveNewPattern() {
    const name = document.getElementById('new-pattern-name').value.trim();
    const category = getCategoryDropdownValue('new-pattern-category');
    const description = document.getElementById('new-pattern-description').value.trim();
    const content = document.getElementById('new-pattern-content').value;
    const isCurrent = document.getElementById('new-pattern-is-current').checked;
    const hashtagIds = getSelectedHashtagIds('new-pattern-hashtags');
    const thumbnailFile = document.getElementById('new-pattern-thumbnail').files[0];

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
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            await fetch(`${API_URL}/api/patterns/${pattern.id}/thumbnail`, {
                method: 'POST',
                body: formData
            });
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

    if (currentCount) {
        currentCount.textContent = showTabCounts ? ` (${currentPatterns.length})` : '';
    }
    if (libraryCount) {
        libraryCount.textContent = showTabCounts ? ` (${patterns.length})` : '';
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
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        };

        container.innerHTML = `
            <div class="library-stats-grid">
                <div class="stat-item">
                    <span class="stat-value">${stats.totalPatterns}</span>
                    <span class="stat-label">Total Patterns</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.currentPatterns}</span>
                    <span class="stat-label">In Progress</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.completedPatterns}</span>
                    <span class="stat-label">Completed</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${formatSize(stats.totalSize)}</span>
                    <span class="stat-label">Library Size</span>
                </div>
            </div>
            <div class="stats-path">
                <span class="stats-path-label">Library Location:</span>
                <code class="stats-path-value">${escapeHtml(stats.libraryPath)}</code>
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
        `;
    } catch (error) {
        console.error('Error loading library stats:', error);
    }
}

function renderCategoriesList() {
    const categoriesList = document.getElementById('categories-list');
    if (!categoriesList) return;

    categoriesList.innerHTML = allCategories.map(category => {
        const patternCount = populatedCategories.find(c => c.name === category)?.count || 0;
        return `
            <div class="category-item" data-category="${escapeHtml(category)}">
                <span class="category-name">${escapeHtml(category)}</span>
                <span class="category-count">${patternCount} pattern${patternCount !== 1 ? 's' : ''}</span>
                <div class="category-actions">
                    <button class="btn btn-small btn-secondary" onclick="editCategory('${escapeHtml(category)}')">Edit</button>
                    <button class="btn btn-small btn-danger" onclick="deleteCategory('${escapeHtml(category)}', ${patternCount})">Delete</button>
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
    } catch (error) {
        console.error('Error adding category:', error);
        alert(error.message);
    }
}

async function editCategory(oldName) {
    const newName = prompt('Enter new category name:', oldName);
    if (!newName || newName === oldName) return;

    if (allCategories.includes(newName)) {
        alert('Category already exists');
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
    } catch (error) {
        console.error('Error updating category:', error);
        alert(error.message);
    }
}

async function deleteCategory(name, patternCount) {
    if (patternCount > 0) {
        alert(`Cannot delete "${name}" because it contains ${patternCount} pattern${patternCount !== 1 ? 's' : ''}. Move or delete the patterns first.`);
        return;
    }

    if (!confirm(`Are you sure you want to delete the category "${name}"?`)) return;

    try {
        const response = await fetch(`${API_URL}/api/categories/${encodeURIComponent(name)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete category');
        }

        await loadCategories();
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
                <button class="btn btn-small btn-secondary" onclick="editHashtag(${hashtag.id}, '${escapeHtml(hashtag.name)}')">Edit</button>
                <button class="btn btn-small btn-danger" onclick="deleteHashtag(${hashtag.id})">Delete</button>
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
    } catch (error) {
        console.error('Error adding hashtag:', error);
        alert(error.message);
    }
}

async function editHashtag(id, oldName) {
    const newName = prompt('Enter new hashtag name:', oldName);
    if (!newName || newName.replace(/^#/, '').toLowerCase() === oldName) return;

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
    } catch (error) {
        console.error('Error updating hashtag:', error);
        alert(error.message);
    }
}

async function deleteHashtag(id) {
    if (!confirm('Are you sure you want to delete this hashtag?')) return;

    try {
        const response = await fetch(`${API_URL}/api/hashtags/${id}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete hashtag');
        }

        await loadHashtags();
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
                ${allHashtags.map(h => `
                    <label class="hashtag-tag ${selectedHashtagIds.includes(h.id) ? 'selected' : ''}">
                        <input type="checkbox" value="${h.id}"
                               ${selectedHashtagIds.includes(h.id) ? 'checked' : ''}
                               ${disabled ? 'disabled' : ''}
                               onchange="toggleHashtagSelection('${id}', ${h.id}, this.checked)">
                        <span>#${escapeHtml(h.name)}</span>
                    </label>
                `).join('')}
                ${!disabled ? `
                    <div class="hashtag-add-inline">
                        <input type="text" placeholder="Add new..."
                               onkeydown="handleNewHashtagInline(event, '${id}')"
                               onclick="event.stopPropagation()">
                    </div>
                ` : ''}
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
    } catch (error) {
        console.error('Error adding hashtag:', error);
        alert(error.message);
    }
}

function toggleHashtagSelection(selectorId, hashtagId, isSelected) {
    const selector = document.querySelector(`.hashtag-selector[data-id="${selectorId}"]`);
    if (!selector) return;

    // Update visual state
    const label = selector.querySelector(`input[value="${hashtagId}"]`).parentElement;
    label.classList.toggle('selected', isSelected);

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
    const sortSelect = document.getElementById('sort-select');
    const showCompletedCheckbox = document.getElementById('show-completed');
    const showCurrentCheckbox = document.getElementById('show-current');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase();
            displayPatterns();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            selectedSort = e.target.value;
            displayPatterns();
        });
    }

    if (showCompletedCheckbox) {
        showCompletedCheckbox.addEventListener('change', (e) => {
            showCompleted = e.target.checked;
            displayPatterns();
        });
    }

    if (showCurrentCheckbox) {
        showCurrentCheckbox.addEventListener('change', (e) => {
            showCurrent = e.target.checked;
            displayPatterns();
        });
    }
}

function displayCurrentPatterns() {
    const grid = document.getElementById('current-patterns-grid');

    if (currentPatterns.length === 0) {
        grid.innerHTML = '<p class="empty-state">No current patterns. Mark a pattern as current to start tracking!</p>';
        return;
    }

    grid.innerHTML = currentPatterns.map(pattern => {
        const hashtags = pattern.hashtags || [];
        const hashtagsHtml = hashtags.length > 0
            ? `<div class="pattern-hashtags">${hashtags.map(h => `<span class="pattern-hashtag">#${escapeHtml(h.name)}</span>`).join('')}</div>`
            : '';

        return `
            <div class="pattern-card" onclick="openPDFViewer(${pattern.id})">
                ${pattern.completed ? '<span class="completed-badge">COMPLETE</span>' : '<span class="current-badge">CURRENT</span>'}
                ${pattern.category ? `<span class="category-badge-overlay">${escapeHtml(pattern.category)}</span>` : ''}
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
                <h3>${escapeHtml(pattern.name)}</h3>
                <p class="pattern-date">${new Date(pattern.upload_date).toLocaleDateString()}</p>
                ${pattern.description ? `<p class="pattern-description">${escapeHtml(pattern.description)}</p>` : ''}
                ${hashtagsHtml}
                ${pattern.completed && pattern.completed_date ? `<p class="completion-date">Completed: ${new Date(pattern.completed_date).toLocaleDateString()}</p>` : ''}
            </div>
        `;
    }).join('');
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

    // Sort patterns
    filteredPatterns = [...filteredPatterns].sort((a, b) => {
        switch (selectedSort) {
            case 'date-desc':
                return new Date(b.upload_date) - new Date(a.upload_date);
            case 'date-asc':
                return new Date(a.upload_date) - new Date(b.upload_date);
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
        const hashtags = pattern.hashtags || [];
        const hashtagsHtml = hashtags.length > 0
            ? `<div class="pattern-hashtags">${hashtags.map(h => `<span class="pattern-hashtag">#${escapeHtml(h.name)}</span>`).join('')}</div>`
            : '';

        return `
            <div class="pattern-card" onclick="openPDFViewer(${pattern.id})">
                ${pattern.completed ? '<span class="completed-badge">COMPLETE</span>' : ''}
                ${!pattern.completed && pattern.is_current ? '<span class="current-badge">CURRENT</span>' : ''}
                ${pattern.category ? `<span class="category-badge-overlay">${escapeHtml(pattern.category)}</span>` : ''}
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
                <h3>${escapeHtml(pattern.name)}</h3>
                <p class="pattern-date">${new Date(pattern.upload_date).toLocaleDateString()}</p>
                <div class="pattern-actions" onclick="event.stopPropagation()">
                    <button class="btn btn-success btn-small"
                            onclick="toggleCurrent('${pattern.id}', ${!pattern.is_current})">
                        ${pattern.is_current ? 'Remove from Current' : 'Make Current'}
                    </button>
                    <button class="btn btn-warning btn-small"
                            onclick="toggleComplete('${pattern.id}', ${!pattern.completed})">
                        ${pattern.completed ? 'Mark Incomplete' : 'Mark Complete'}
                    </button>
                    <button class="btn btn-secondary btn-small" onclick="openEditModal('${pattern.id}')">Edit</button>
                    <button class="btn btn-danger btn-small" onclick="deletePattern('${pattern.id}')">Delete</button>
                </div>
                ${pattern.description ? `<p class="pattern-description">${escapeHtml(pattern.description)}</p>` : ''}
                ${hashtagsHtml}
                ${pattern.completed && pattern.completed_date ? `<p class="completion-date">Completed: ${new Date(pattern.completed_date).toLocaleDateString()}</p>` : ''}
            </div>
        `;
    }).join('');
}

async function toggleCurrent(id, isCurrent) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/current`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isCurrent })
        });

        if (response.ok) {
            await loadPatterns();
            await loadCurrentPatterns();
        } else {
            const error = await response.json();
            console.error('Error updating pattern:', error.error);
        }
    } catch (error) {
        console.error('Error toggling current status:', error);
    }
}

async function toggleComplete(id, completed) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/complete`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed })
        });

        if (response.ok) {
            await loadPatterns();
            await loadCurrentPatterns();
        } else {
            const error = await response.json();
            console.error('Error updating completion status:', error.error);
        }
    } catch (error) {
        console.error('Error toggling completion status:', error);
    }
}

async function deletePattern(id) {
    if (!confirm('Are you sure you want to delete this pattern?')) {
        return;
    }

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

// PDF Viewer functionality
function initPDFViewer() {
    const backBtn = document.getElementById('pdf-back-btn');
    const prevPageBtn = document.getElementById('prev-page-btn');
    const nextPageBtn = document.getElementById('next-page-btn');
    const addCounterBtn = document.getElementById('add-counter-btn');
    const notesBtn = document.getElementById('pdf-notes-btn');
    const notesCloseBtn = document.getElementById('notes-close-btn');

    backBtn.addEventListener('click', closePDFViewer);
    prevPageBtn.addEventListener('click', () => changePage(-1));
    nextPageBtn.addEventListener('click', () => changePage(1));
    addCounterBtn.addEventListener('click', () => addCounter());
    notesBtn.addEventListener('click', toggleNotesPopover);
    notesCloseBtn.addEventListener('click', closeNotesPopover);

    // Notes auto-save on input
    const notesEditor = document.getElementById('notes-editor');
    notesEditor.addEventListener('input', scheduleNotesAutoSave);

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
        if (pdfViewerContainer.style.display !== 'flex') {
            return;
        }

        // Don't trigger if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        switch(e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                changePage(-1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                changePage(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                incrementLastUsedCounter();
                break;
            case 'ArrowDown':
                e.preventDefault();
                decrementLastUsedCounter();
                break;
            case ' ':
                e.preventDefault();
                incrementLastUsedCounter();
                break;
        }
    });
}

async function openPDFViewer(patternId) {
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

        // Route to appropriate viewer based on pattern type
        if (pattern.pattern_type === 'markdown') {
            await openMarkdownViewer(pattern);
            return;
        }

        currentPattern = pattern;
        currentPageNum = pattern.current_page || 1;

        // Hide tabs and show PDF viewer
        document.querySelector('.tabs').style.display = 'none';
        tabContents.forEach(c => c.style.display = 'none');
        pdfViewerContainer.style.display = 'flex';

        // Update header
        document.getElementById('pdf-pattern-name').textContent = pattern.name;

        // Load PDF
        const pdfUrl = `${API_URL}/api/patterns/${pattern.id}/file`;
        const loadingTask = pdfjsLib.getDocument(pdfUrl);

        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        // Render the current page
        await renderPage(currentPageNum);

        // Load counters
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

        // Calculate scale to fit width
        const containerWidth = document.querySelector('.pdf-viewer-wrapper').clientWidth - 40;
        const viewport = page.getViewport({ scale: 1 });
        const scale = Math.min(containerWidth / viewport.width, 2.0);

        const scaledViewport = page.getViewport({ scale: scale });

        canvas.height = scaledViewport.height;
        canvas.width = scaledViewport.width;

        const renderContext = {
            canvasContext: context,
            viewport: scaledViewport
        };

        await page.render(renderContext).promise;

        // Update page info
        document.getElementById('page-info').textContent = `Page ${pageNum} of ${totalPages}`;

        // Update button states
        document.getElementById('prev-page-btn').disabled = pageNum <= 1;
        document.getElementById('next-page-btn').disabled = pageNum >= totalPages;

    } catch (error) {
        console.error('Error rendering page:', error);
    }
}

async function changePage(delta) {
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
    // Save current page before closing
    if (currentPattern && currentPageNum) {
        try {
            await fetch(`${API_URL}/api/patterns/${currentPattern.id}/page`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPage: currentPageNum })
            });
        } catch (error) {
            console.error('Error saving page on close:', error);
        }
    }

    pdfViewerContainer.style.display = 'none';
    document.querySelector('.tabs').style.display = 'flex';

    // Restore the previously active tab
    const lastActiveTab = localStorage.getItem('activeTab') || 'current-patterns';
    switchToTab(lastActiveTab);

    currentPattern = null;
    pdfDoc = null;
    lastUsedCounterId = null;

    // Reload the appropriate content based on which tab we're returning to
    if (lastActiveTab === 'current-patterns') {
        loadCurrentPatterns();
    } else if (lastActiveTab === 'all-patterns') {
        loadPatterns();
    }
}

// Counter functionality
async function loadCounters(patternId) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${patternId}/counters`);
        counters = await response.json();

        // If no counters exist, create a default one
        if (counters.length === 0) {
            await addCounter('Row Counter');
        } else {
            displayCounters();
        }
    } catch (error) {
        console.error('Error loading counters:', error);
    }
}

function displayCounters() {
    // Check if markdown viewer is active
    const markdownViewer = document.getElementById('markdown-viewer-container');
    if (markdownViewer && markdownViewer.style.display !== 'none') {
        displayMarkdownCounters();
        return;
    }

    const countersList = document.getElementById('counters-list');

    if (counters.length === 0) {
        countersList.innerHTML = '<p style="text-align: center; color: #6b7280;">No counters. Click "Add Counter" to create one.</p>';
        return;
    }

    countersList.innerHTML = counters.map(counter => `
        <div class="counter-item" data-counter-id="${counter.id}">
            <div class="counter-name">
                <input type="text" value="${escapeHtml(counter.name)}"
                       onchange="updateCounterName(${counter.id}, this.value)"
                       placeholder="Counter name">
            </div>
            <div class="counter-value">${counter.value}</div>
            <div class="counter-controls">
                <button class="counter-btn counter-btn-minus" onclick="decrementCounter(${counter.id})">−</button>
                <button class="counter-btn counter-btn-plus" onclick="incrementCounter(${counter.id})">+</button>
                <button class="counter-btn counter-btn-delete" onclick="deleteCounter(${counter.id})">Delete</button>
            </div>
        </div>
    `).join('');
}

async function addCounter(defaultName = '') {
    if (!currentPattern) return;

    let name = defaultName;
    if (!name) {
        const promptResult = prompt('Enter counter name:', 'New Counter');
        if (promptResult === null) return; // User cancelled
        name = promptResult.trim() || 'New Counter'; // Use default if empty
    }

    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/counters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, value: 0 })
        });

        if (response.ok) {
            const newCounter = await response.json();
            counters.push(newCounter);
            displayCounters();
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

async function deleteCounter(counterId) {
    if (!confirm('Delete this counter?')) return;

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

    // Restore saved size from localStorage
    const savedSize = localStorage.getItem('notesPopoverSize');
    if (savedSize) {
        try {
            const { width, height } = JSON.parse(savedSize);
            popover.style.width = width + 'px';
            popover.style.height = height + 'px';
        } catch (e) {
            // Ignore invalid saved data
        }
    }

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

    popover.style.display = 'flex';
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

// Simple markdown renderer
function renderMarkdown(text) {
    if (!text) return '<p class="notes-empty">No notes yet.</p>';

    let html = escapeHtml(text);

    // Code blocks (must come before inline code)
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Line breaks to paragraphs
    html = html.split(/\n\n+/).map(p => {
        p = p.trim();
        if (!p) return '';
        if (p.startsWith('<h') || p.startsWith('<pre') || p.startsWith('<ul') || p.startsWith('<ol') || p.startsWith('<blockquote')) {
            return p;
        }
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');

    return html;
}

// Edit modal functionality
function initEditModal() {
    const modal = document.getElementById('edit-modal');
    const closeBtn = document.getElementById('close-edit-modal');
    const cancelBtn = document.getElementById('cancel-edit-btn');
    const editForm = document.getElementById('edit-form');

    closeBtn.addEventListener('click', closeEditModal);
    cancelBtn.addEventListener('click', closeEditModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeEditModal();
        }
    });

    editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await savePatternEdits();
    });
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
    categoryContainer.innerHTML = createCategoryDropdown('edit-category', pattern.category || 'Amigurumi');

    document.getElementById('edit-pattern-description').value = pattern.description || '';

    // Create hashtag selector with current pattern's hashtags
    const hashtagContainer = document.getElementById('edit-pattern-hashtags-container');
    const selectedHashtagIds = (pattern.hashtags || []).map(h => h.id);
    hashtagContainer.innerHTML = createHashtagSelector('edit-hashtags', selectedHashtagIds);

    document.getElementById('edit-thumbnail').value = '';

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
    const thumbnailFile = document.getElementById('edit-thumbnail').files[0];
    const hashtagIds = getSelectedHashtagIds('edit-hashtags');

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

        // Update hashtags
        await fetch(`${API_URL}/api/patterns/${editingPatternId}/hashtags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashtagIds })
        });

        // If custom thumbnail was uploaded, handle it separately
        if (thumbnailFile) {
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            await fetch(`${API_URL}/api/patterns/${editingPatternId}/thumbnail`, {
                method: 'POST',
                body: formData
            });
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

async function openMarkdownViewer(pattern) {
    try {
        currentPattern = pattern;

        // Hide tabs and show markdown viewer
        document.querySelector('.tabs').style.display = 'none';
        tabContents.forEach(c => c.style.display = 'none');
        markdownViewerContainer.style.display = 'flex';

        // Update header
        document.getElementById('markdown-pattern-name').textContent = pattern.name;

        // Load markdown content from file
        const contentResponse = await fetch(`${API_URL}/api/patterns/${pattern.id}/content`);
        if (contentResponse.ok) {
            const data = await contentResponse.json();
            const markdownContent = document.getElementById('markdown-content');
            markdownContent.innerHTML = renderMarkdown(data.content || '');
        }

        // Load counters
        await loadMarkdownCounters(pattern.id);

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

    // Edit button
    const editBtn = document.getElementById('markdown-edit-btn');
    editBtn.onclick = openMarkdownEditModal;

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

    // Add counter button
    const addCounterBtn = document.getElementById('markdown-add-counter-btn');
    addCounterBtn.onclick = () => addCounter('Counter');

    // Edit modal events
    const closeEditModalBtn = document.getElementById('close-markdown-edit-modal');
    closeEditModalBtn.onclick = closeMarkdownEditModal;

    const cancelEditBtn = document.getElementById('cancel-markdown-edit');
    cancelEditBtn.onclick = closeMarkdownEditModal;

    const saveEditBtn = document.getElementById('save-markdown-edit');
    saveEditBtn.onclick = saveMarkdownEdit;

    const editModal = document.getElementById('markdown-edit-modal');
    editModal.onclick = (e) => {
        if (e.target === editModal) closeMarkdownEditModal();
    };

    // Live preview in edit modal
    const editContent = document.getElementById('markdown-edit-content');
    editContent.oninput = () => {
        document.getElementById('markdown-edit-preview').innerHTML = renderMarkdown(editContent.value);
    };
}

async function closeMarkdownViewer() {
    markdownViewerContainer.style.display = 'none';
    document.querySelector('.tabs').style.display = 'flex';

    // Restore the previously active tab
    const lastActiveTab = localStorage.getItem('activeTab') || 'current';
    switchToTab(lastActiveTab);

    currentPattern = null;
    lastUsedCounterId = null;

    // Reload the appropriate content
    if (lastActiveTab === 'current') {
        loadCurrentPatterns();
    } else if (lastActiveTab === 'library') {
        loadPatterns();
    }
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

// Markdown counters (reuse existing counter logic)
async function loadMarkdownCounters(patternId) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${patternId}/counters`);
        counters = await response.json();

        if (counters.length === 0) {
            await addCounter('Row Counter');
        } else {
            displayMarkdownCounters();
        }
    } catch (error) {
        console.error('Error loading counters:', error);
    }
}

function displayMarkdownCounters() {
    const countersList = document.getElementById('markdown-counters-list');

    if (!countersList) return;

    if (counters.length === 0) {
        countersList.innerHTML = '<p style="text-align: center; color: #6b7280;">No counters. Click "Add Counter" to create one.</p>';
        return;
    }

    countersList.innerHTML = counters.map(counter => `
        <div class="counter-item" data-counter-id="${counter.id}">
            <div class="counter-name">
                <input type="text" value="${escapeHtml(counter.name)}"
                       onchange="updateCounterName(${counter.id}, this.value)"
                       placeholder="Counter name">
            </div>
            <div class="counter-value">${counter.value}</div>
            <div class="counter-controls">
                <button class="counter-btn counter-btn-minus" onclick="decrementCounter(${counter.id})">−</button>
                <button class="counter-btn counter-btn-plus" onclick="incrementCounter(${counter.id})">+</button>
                <button class="counter-btn counter-btn-delete" onclick="deleteCounter(${counter.id})">Delete</button>
            </div>
        </div>
    `).join('');
}

// Markdown edit modal
async function openMarkdownEditModal() {
    const modal = document.getElementById('markdown-edit-modal');
    const textarea = document.getElementById('markdown-edit-content');
    const preview = document.getElementById('markdown-edit-preview');

    // Load content from file
    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/content`);
        if (response.ok) {
            const data = await response.json();
            textarea.value = data.content || '';
            preview.innerHTML = renderMarkdown(data.content || '');
        }
    } catch (error) {
        console.error('Error loading content:', error);
    }

    modal.style.display = 'flex';
}

function closeMarkdownEditModal() {
    document.getElementById('markdown-edit-modal').style.display = 'none';
}

async function saveMarkdownEdit() {
    const content = document.getElementById('markdown-edit-content').value;

    try {
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });

        if (response.ok) {
            // Update the viewer
            document.getElementById('markdown-content').innerHTML = renderMarkdown(content);
            closeMarkdownEditModal();
        } else {
            console.error('Error saving content');
        }
    } catch (error) {
        console.error('Error saving content:', error);
    }
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
