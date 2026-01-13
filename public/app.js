// API base URL
const API_URL = '';

// State
let patterns = [];
let currentPatterns = [];
let allTags = [];
let selectedFile = null;
let editingPatternId = null;

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
    loadPatterns();
    loadCurrentPatterns();
    loadTags();
});

// Theme toggle
function initTheme() {
    const themeToggle = document.getElementById('theme-toggle');
    const themeIcon = document.querySelector('.theme-icon');

    const currentTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);
    updateThemeIcon(currentTheme, themeIcon);

    themeToggle.addEventListener('click', () => {
        const theme = document.documentElement.getAttribute('data-theme');
        const newTheme = theme === 'light' ? 'dark' : 'light';

        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateThemeIcon(newTheme, themeIcon);
    });
}

function updateThemeIcon(theme, iconElement) {
    iconElement.textContent = theme === 'light' ? '🌙' : '☀️';
}

// Tab switching
function initTabs() {
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;

            // Remove active from all tabs and contents
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => {
                c.classList.remove('active');
                c.style.display = 'none';
            });

            // Activate clicked tab
            btn.classList.add('active');
            const content = document.getElementById(tabName);
            content.classList.add('active');
            content.style.display = 'block';

            // Hide PDF viewer
            pdfViewerContainer.style.display = 'none';
        });
    });
}

// Upload functionality
function initUpload() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const uploadForm = document.getElementById('upload-form');
    const uploadBtn = document.getElementById('upload-btn');

    // Click to browse
    dropZone.addEventListener('click', () => fileInput.click());
    browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    // File input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // Drag and drop
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

        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type === 'application/pdf') {
            handleFile(files[0]);
        } else {
            alert('Please drop a PDF file');
        }
    });

    // Form submission
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await uploadPattern();
    });
}

function handleFile(file) {
    if (file.type !== 'application/pdf') {
        alert('Please select a PDF file');
        return;
    }

    selectedFile = file;
    const dropZone = document.getElementById('drop-zone');
    const uploadBtn = document.getElementById('upload-btn');

    dropZone.querySelector('.drop-zone-text').textContent = `Selected: ${file.name}`;
    uploadBtn.disabled = false;

    // Auto-fill pattern name if empty
    const nameInput = document.getElementById('pattern-name');
    if (!nameInput.value) {
        nameInput.value = file.name.replace('.pdf', '');
    }
}

async function uploadPattern() {
    if (!selectedFile) {
        alert('Please select a file');
        return;
    }

    const formData = new FormData();
    const name = document.getElementById('pattern-name').value;
    const tags = document.getElementById('pattern-tags').value;
    const notes = document.getElementById('pattern-notes').value;
    const isCurrent = document.getElementById('is-current').checked;

    formData.append('pdf', selectedFile);
    formData.append('name', name);
    formData.append('tags', tags);
    formData.append('notes', notes);
    formData.append('isCurrent', isCurrent);

    try {
        const response = await fetch(`${API_URL}/api/patterns`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            alert('Pattern uploaded successfully!');
            resetUploadForm();
            await loadPatterns();
            await loadCurrentPatterns();
            await loadTags();
        } else {
            const error = await response.json();
            alert('Error uploading pattern: ' + error.error);
        }
    } catch (error) {
        console.error('Error uploading pattern:', error);
        alert('Error uploading pattern');
    }
}

function resetUploadForm() {
    document.getElementById('upload-form').reset();
    document.getElementById('file-input').value = '';
    document.getElementById('drop-zone').querySelector('.drop-zone-text').textContent = 'Drag & drop PDF here or click to browse';
    document.getElementById('upload-btn').disabled = true;
    selectedFile = null;
}

// Load patterns
async function loadPatterns() {
    try {
        const response = await fetch(`${API_URL}/api/patterns`);
        patterns = await response.json();
        displayPatterns();
    } catch (error) {
        console.error('Error loading patterns:', error);
    }
}

async function loadCurrentPatterns() {
    try {
        const response = await fetch(`${API_URL}/api/patterns/current`);
        currentPatterns = await response.json();
        displayCurrentPatterns();
    } catch (error) {
        console.error('Error loading current patterns:', error);
    }
}

async function loadTags() {
    try {
        const response = await fetch(`${API_URL}/api/tags`);
        allTags = await response.json();
        updateTagSuggestions();
    } catch (error) {
        console.error('Error loading tags:', error);
    }
}

function updateTagSuggestions() {
    const datalist = document.getElementById('tag-suggestions');
    datalist.innerHTML = allTags.map(tag => `<option value="${escapeHtml(tag)}">`).join('');
}

function displayCurrentPatterns() {
    const grid = document.getElementById('current-patterns-grid');

    if (currentPatterns.length === 0) {
        grid.innerHTML = '<p class="empty-state">No current patterns. Mark a pattern as current to start tracking!</p>';
        return;
    }

    grid.innerHTML = currentPatterns.map(pattern => `
        <div class="pattern-card" onclick="openPDFViewer(${pattern.id})">
            <span class="current-badge">CURRENT</span>
            ${pattern.thumbnail ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" class="pattern-thumbnail" alt="${escapeHtml(pattern.name)}">` : ''}
            <h3>${escapeHtml(pattern.name)}</h3>
            <p class="pattern-date">${new Date(pattern.upload_date).toLocaleDateString()}</p>
            ${pattern.tags && pattern.tags.length > 0 ? `
                <div class="pattern-tags">
                    ${pattern.tags.map(tag => `<span class="pattern-tag">${escapeHtml(tag)}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    `).join('');
}

function displayPatterns() {
    const grid = document.getElementById('patterns-grid');

    if (patterns.length === 0) {
        grid.innerHTML = '<p class="empty-state">No patterns yet. Upload your first pattern!</p>';
        return;
    }

    grid.innerHTML = patterns.map(pattern => `
        <div class="pattern-card" onclick="openPDFViewer(${pattern.id})" style="cursor: pointer;">
            ${pattern.is_current ? '<span class="current-badge">CURRENT</span>' : ''}
            ${pattern.thumbnail ? `<img src="${API_URL}/api/patterns/${pattern.id}/thumbnail" class="pattern-thumbnail" alt="${escapeHtml(pattern.name)}">` : ''}
            <h3>${escapeHtml(pattern.name)}</h3>
            <p class="pattern-date">${new Date(pattern.upload_date).toLocaleDateString()}</p>
            ${pattern.tags && pattern.tags.length > 0 ? `
                <div class="pattern-tags">
                    ${pattern.tags.map(tag => `<span class="pattern-tag">${escapeHtml(tag)}</span>`).join('')}
                </div>
            ` : ''}
            ${pattern.notes ? `<p class="pattern-notes">${escapeHtml(pattern.notes)}</p>` : ''}
            <div class="pattern-actions" onclick="event.stopPropagation()">
                <button class="btn btn-primary btn-small" onclick="openPDFViewer('${pattern.id}')">View PDF</button>
                <button class="btn btn-${pattern.is_current ? 'secondary' : 'success'} btn-small"
                        onclick="toggleCurrent('${pattern.id}', ${!pattern.is_current})">
                    ${pattern.is_current ? 'Remove from Current' : 'Mark as Current'}
                </button>
                <button class="btn btn-secondary btn-small" onclick="openEditModal('${pattern.id}')">Edit</button>
                <button class="btn btn-danger btn-small" onclick="deletePattern('${pattern.id}')">Delete</button>
            </div>
        </div>
    `).join('');
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
            alert('Error updating pattern: ' + error.error);
        }
    } catch (error) {
        console.error('Error toggling current status:', error);
        alert('Error updating pattern');
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
        } else {
            const error = await response.json();
            alert('Error deleting pattern: ' + error.error);
        }
    } catch (error) {
        console.error('Error deleting pattern:', error);
        alert('Error deleting pattern');
    }
}

// PDF Viewer functionality
function initPDFViewer() {
    const backBtn = document.getElementById('pdf-back-btn');
    const prevPageBtn = document.getElementById('prev-page-btn');
    const nextPageBtn = document.getElementById('next-page-btn');
    const addCounterBtn = document.getElementById('add-counter-btn');

    backBtn.addEventListener('click', closePDFViewer);
    prevPageBtn.addEventListener('click', () => changePage(-1));
    nextPageBtn.addEventListener('click', () => changePage(1));
    addCounterBtn.addEventListener('click', () => addCounter());

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

        // First try to find in current patterns, then in all patterns
        let pattern = currentPatterns.find(p => p.id === id);
        if (!pattern) {
            pattern = patterns.find(p => p.id === id);
        }

        // If still not found, fetch from API
        if (!pattern) {
            const response = await fetch(`${API_URL}/api/patterns/${id}`);
            if (!response.ok) {
                alert('Pattern not found');
                return;
            }
            pattern = await response.json();
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
        alert('Error loading PDF');
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

function closePDFViewer() {
    pdfViewerContainer.style.display = 'none';
    document.querySelector('.tabs').style.display = 'flex';

    // Reset all tabs and show current tab
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => {
        c.classList.remove('active');
        c.style.display = 'none';
    });

    // Activate the current patterns tab
    const currentTab = document.querySelector('[data-tab="current"]');
    const currentContent = document.getElementById('current');
    currentTab.classList.add('active');
    currentContent.classList.add('active');
    currentContent.style.display = 'block';

    currentPattern = null;
    pdfDoc = null;
    lastUsedCounterId = null;
    loadCurrentPatterns();
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
        alert('Pattern not found');
        return;
    }

    document.getElementById('edit-pattern-name').value = pattern.name;
    document.getElementById('edit-pattern-tags').value = pattern.tags ? pattern.tags.join(', ') : '';
    document.getElementById('edit-pattern-notes').value = pattern.notes || '';
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
    const tags = document.getElementById('edit-pattern-tags').value;
    const notes = document.getElementById('edit-pattern-notes').value;
    const thumbnailFile = document.getElementById('edit-thumbnail').files[0];

    try {
        // Update pattern details
        const response = await fetch(`${API_URL}/api/patterns/${editingPatternId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, tags, notes })
        });

        if (!response.ok) {
            const error = await response.json();
            alert('Error updating pattern: ' + error.error);
            return;
        }

        // If custom thumbnail was uploaded, handle it separately
        if (thumbnailFile) {
            const formData = new FormData();
            formData.append('thumbnail', thumbnailFile);

            await fetch(`${API_URL}/api/patterns/${editingPatternId}/thumbnail`, {
                method: 'POST',
                body: formData
            });
        }

        alert('Pattern updated successfully!');
        closeEditModal();
        await loadPatterns();
        await loadCurrentPatterns();
        await loadTags();
    } catch (error) {
        console.error('Error updating pattern:', error);
        alert('Error updating pattern');
    }
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
