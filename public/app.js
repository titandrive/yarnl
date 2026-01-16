// API base URL
const API_URL = '';

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
let currentPatterns = [];
let allCategories = []; // All possible categories for editing/uploading
let populatedCategories = []; // Only categories with patterns (for filtering)
let allHashtags = []; // All available hashtags
let selectedFile = null;
let editingPatternId = null;
let stagedFiles = []; // Array to hold staged files with metadata
let selectedCategoryFilter = localStorage.getItem('libraryCategoryFilter') || 'all';
let selectedSort = localStorage.getItem('librarySort') || 'date-desc';
let showCompleted = localStorage.getItem('libraryShowCompleted') !== 'false';
let showCurrent = localStorage.getItem('libraryShowCurrent') !== 'false';
let showPdf = localStorage.getItem('libraryShowPdf') !== 'false';
let showMarkdown = localStorage.getItem('libraryShowMarkdown') !== 'false';
let highlightMode = localStorage.getItem('libraryHighlightMode') || 'none';
let searchQuery = '';
let previousTab = 'current';
let navigationHistory = []; // Stack for UI back button
let isNavigatingBack = false; // Flag to prevent double history push
let showTabCounts = localStorage.getItem('showTabCounts') !== 'false';
let showTypeBadge = localStorage.getItem('showTypeBadge') !== 'false';
let showStatusBadge = localStorage.getItem('showStatusBadge') !== 'false';
let showCategoryBadge = localStorage.getItem('showCategoryBadge') !== 'false';
let defaultCategory = localStorage.getItem('defaultCategory') || 'Amigurumi';

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
    counterIncrease: ['ArrowUp', ''],
    counterDecrease: ['ArrowDown', ''],
    prevPage: ['ArrowLeft', ''],
    nextPage: ['ArrowRight', ''],
    toggleTimer: [' ', ''], // Space
    nextCounter: ['Tab', ''],
    zoomIn: ['=', '+'], // = is unshifted + on most keyboards
    zoomOut: ['-', ''],
    exitViewer: ['Escape', '']
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

    // Stop timer when window/tab becomes hidden or closes
    document.addEventListener('visibilitychange', () => {
        // Timer continues running when tab is not visible (background)
        // Only stop on actual close (handled by beforeunload)
    });

    window.addEventListener('beforeunload', () => {
        if (timerRunning) {
            stopTimer(true); // Save synchronously before page unload
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
    const timeString = formatTime(timerSeconds);

    if (pdfDisplay) pdfDisplay.textContent = timeString;
    if (markdownDisplay) markdownDisplay.textContent = timeString;
}

function updateTimerButtonState() {
    const pdfBtn = document.getElementById('pdf-timer-btn');
    const markdownBtn = document.getElementById('markdown-timer-btn');

    if (timerRunning) {
        if (pdfBtn) pdfBtn.classList.add('timer-running');
        if (markdownBtn) markdownBtn.classList.add('timer-running');
    } else {
        if (pdfBtn) pdfBtn.classList.remove('timer-running');
        if (markdownBtn) markdownBtn.classList.remove('timer-running');
    }
}

function toggleTimer() {
    if (timerRunning) {
        stopTimer();
    } else {
        startTimer();
    }
}

function startTimer() {
    if (timerRunning || !currentPattern) return;

    timerRunning = true;
    updateTimerButtonState();

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

    if (timerResetConfirming) {
        if (pdfResetBtn) pdfResetBtn.classList.add('confirming');
        if (markdownResetBtn) markdownResetBtn.classList.add('confirming');
    } else {
        if (pdfResetBtn) pdfResetBtn.classList.remove('confirming');
        if (markdownResetBtn) markdownResetBtn.classList.remove('confirming');
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

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
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
    initServerEvents();
    await loadPatterns();
    loadCurrentPatterns();
    loadCategories();
    loadHashtags();

    // Handle initial URL hash or restore pattern viewer
    await handleInitialNavigation();
});

// Server-sent events for real-time notifications
function initServerEvents() {
    const eventSource = new EventSource(`${API_URL}/api/events`);

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerEvent(data);
        } catch (error) {
            console.error('Error parsing server event:', error);
        }
    };

    eventSource.onerror = (error) => {
        console.log('SSE connection error, will reconnect automatically');
    };
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

    // No hash - check sessionStorage for refresh persistence
    const viewingPatternId = sessionStorage.getItem('viewingPatternId');
    if (viewingPatternId) {
        const pattern = patterns.find(p => p.id === parseInt(viewingPatternId));
        if (pattern) {
            await openPDFViewer(parseInt(viewingPatternId), false);
            const slug = getPatternSlug(pattern);
            history.replaceState({ view: `pattern/${slug}` }, '', `#pattern/${slug}`);
        }
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

    // Remove existing custom font link if any
    const existingLink = document.getElementById('custom-google-font');
    if (existingLink) existingLink.remove();

    // Load font from Google Fonts
    const link = document.createElement('link');
    link.id = 'custom-google-font';
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${fontToLoad.replace(/ /g, '+')}:wght@300;400;500;600;700&display=swap`;
    document.head.appendChild(link);

    // Apply font to document
    document.documentElement.style.setProperty('--font-family', `"${fontToLoad}", sans-serif`);
}

// Theme toggle
function initTheme() {
    const themeSelect = document.getElementById('theme-select');
    const gradientCheckbox = document.getElementById('gradient-checkbox');

    // Migrate old theme settings to new format
    let currentTheme = localStorage.getItem('theme') || 'lavender-dark';
    if (currentTheme === 'dark') currentTheme = 'lavender-dark';
    if (currentTheme === 'light') currentTheme = 'lavender-light';

    document.documentElement.setAttribute('data-theme', currentTheme);

    // Gradient setting (default off)
    const useGradient = localStorage.getItem('useGradient') === 'true';
    document.documentElement.setAttribute('data-gradient', useGradient);

    if (themeSelect) {
        themeSelect.value = currentTheme;

        themeSelect.addEventListener('change', () => {
            const newTheme = themeSelect.value;
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            showToast('Theme updated');
        });
    }

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

    // Reset appearance to defaults
    const resetAppearanceBtn = document.getElementById('reset-appearance-btn');
    if (resetAppearanceBtn) {
        resetAppearanceBtn.addEventListener('click', () => {
            // Reset theme
            localStorage.setItem('theme', 'lavender-dark');
            document.documentElement.setAttribute('data-theme', 'lavender-dark');
            if (themeSelect) themeSelect.value = 'lavender-dark';

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
            showToast('Settings reset to defaults');
        });
    }
}

// Tab switching
function initTabs() {
    // Check if we're restoring a pattern viewer - don't show tabs in that case
    // Check both sessionStorage (for refresh) and URL hash (for cmd+click new tab)
    const viewingPatternId = sessionStorage.getItem('viewingPatternId');
    const hash = window.location.hash.slice(1);
    const isOpeningPattern = viewingPatternId || hash.startsWith('pattern/');

    if (isOpeningPattern) {
        // Hide tabs, content will be shown when pattern viewer opens
        document.querySelector('.tabs').style.display = 'none';
        tabContents.forEach(c => c.style.display = 'none');
    } else {
        // Use sessionStorage for current tab (survives refresh, clears on new tab)
        // Use localStorage defaultPage only for fresh visits
        const currentTab = sessionStorage.getItem('activeTab');
        const defaultPage = localStorage.getItem('defaultPage') || 'current';
        const startTab = currentTab || defaultPage;
        switchToTab(startTab, false); // Don't push to history during init
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            switchToTab(tabName);
            // Save to sessionStorage so refresh stays on same page
            sessionStorage.setItem('activeTab', tabName);
        });
    });
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

    // Hide PDF viewer and markdown viewer
    pdfViewerContainer.style.display = 'none';
    const markdownViewer = document.getElementById('markdown-viewer-container');
    if (markdownViewer) markdownViewer.style.display = 'none';
    document.querySelector('.tabs').style.display = 'flex';

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

function navigateBack() {
    if (navigationHistory.length > 0) {
        isNavigatingBack = true;
        const previousView = navigationHistory.pop();
        // Just update the view, don't call history.back() as it causes double navigation
        navigateToView(previousView, false);
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
            category: getDefaultCategory(),
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
                    <div class="form-group mark-current-toggle">
                        <span class="mark-current-label">Mark as current pattern</span>
                        <label class="toggle-switch">
                            <input type="checkbox"
                                   ${stagedFile.isCurrent ? 'checked' : ''}
                                   onchange="updateStagedFile('${stagedFile.id}', 'isCurrent', this.checked)"
                                   ${isUploading || stagedFile.status === 'success' ? 'disabled' : ''}>
                            <span class="toggle-slider"></span>
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

    // Badge visibility settings
    const badgeTypeCheckbox = document.getElementById('badge-type-checkbox');
    const badgeStatusCheckbox = document.getElementById('badge-status-checkbox');
    const badgeCategoryCheckbox = document.getElementById('badge-category-checkbox');

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

    // Notifications Section
    initNotificationsSection();

    // Settings sidebar navigation
    const settingsNavBtns = document.querySelectorAll('.settings-nav-btn');
    const settingsSections = document.querySelectorAll('.settings-content .settings-section');

    settingsNavBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            switchToSettingsSection(section, true);
        });
    });
}

// Switch to a specific settings section
function switchToSettingsSection(section, updateHistory = true) {
    const settingsNavBtns = document.querySelectorAll('.settings-nav-btn');
    const settingsSections = document.querySelectorAll('.settings-content .settings-section');

    // Update active nav button
    settingsNavBtns.forEach(b => {
        if (b.dataset.section === section) {
            b.classList.add('active');
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
    if (section === 'storage') {
        loadStorageStats();
    } else if (section === 'about') {
        loadLibraryStats();
    }
}

// Storage section initialization
async function loadStorageStats() {
    await loadImagesSizeForBackup();
    loadOrphanedImagesCount();

    // Setup cleanup button if not already set up
    const cleanupBtn = document.getElementById('cleanup-images-btn');
    if (cleanupBtn && !cleanupBtn.hasAttribute('data-initialized')) {
        cleanupBtn.setAttribute('data-initialized', 'true');
        cleanupBtn.addEventListener('click', cleanupOrphanedImages);
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
        '=': '='
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
                return;
            }

            // Cancel any other listening button
            if (listeningBtn) {
                listeningBtn.classList.remove('listening');
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

    // Global keydown handler for capturing shortcuts
    document.addEventListener('keydown', (e) => {
        if (!listeningBtn) return;

        e.preventDefault();
        e.stopPropagation();

        const shortcutName = listeningBtn.dataset.shortcut;
        const index = parseInt(listeningBtn.dataset.index);

        // Escape cancels listening without changes
        if (e.key === 'Escape') {
            listeningBtn.classList.remove('listening');
            listeningBtn = null;
            return;
        }

        // Set the new shortcut
        keyboardShortcuts[shortcutName][index] = e.key;

        // Save to localStorage
        localStorage.setItem('keyboardShortcuts', JSON.stringify(keyboardShortcuts));

        // Update display and stop listening
        listeningBtn.classList.remove('listening');
        updateShortcutDisplays();
        listeningBtn = null;
        showToast('Shortcut updated');
    }, true);

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
                <div class="stat-item">
                    <span class="stat-value">${formatTime(stats.totalTimeSeconds || 0)}</span>
                    <span class="stat-label">Time Crocheting</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value">${stats.patternsWithTime > 0 ? formatTime(Math.round((stats.totalTimeSeconds || 0) / stats.patternsWithTime)) : '–'}</span>
                    <span class="stat-label">Avg Time per Project</span>
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
    // Collect all localStorage settings for backup
    return {
        theme: localStorage.getItem('theme'),
        useGradient: localStorage.getItem('useGradient'),
        tagline: localStorage.getItem('tagline'),
        showTabCounts: localStorage.getItem('showTabCounts'),
        defaultPage: localStorage.getItem('defaultPage'),
        defaultZoom: localStorage.getItem('defaultZoom'),
        showTypeBadge: localStorage.getItem('showTypeBadge'),
        showStatusBadge: localStorage.getItem('showStatusBadge'),
        showCategoryBadge: localStorage.getItem('showCategoryBadge'),
        defaultCategory: localStorage.getItem('defaultCategory'),
        keyboardShortcuts: localStorage.getItem('keyboardShortcuts'),
        backupScheduleEnabled: localStorage.getItem('backupScheduleEnabled'),
        backupSchedule: localStorage.getItem('backupSchedule'),
        backupPruneEnabled: localStorage.getItem('backupPruneEnabled'),
        backupPruneMode: localStorage.getItem('backupPruneMode'),
        backupPruneValue: localStorage.getItem('backupPruneValue'),
        backupTime: localStorage.getItem('backupTime')
    };
}

function applyClientSettings(settings) {
    if (!settings) return;

    // Apply each setting if it exists in the backup
    Object.entries(settings).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            localStorage.setItem(key, value);
        }
    });

    // Reload the page to apply all settings
    window.location.reload();
}

async function createBackup() {
    const btn = document.getElementById('create-backup-btn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating backup...';

    const includePatterns = document.getElementById('backup-include-patterns')?.checked ?? true;
    const includeImages = document.getElementById('backup-include-images')?.checked ?? true;

    try {
        const response = await fetch(`${API_URL}/api/backups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientSettings: getClientSettings(),
                includePatterns,
                includeImages
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create backup');
        }

        const result = await response.json();
        await loadBackups();
        alert(`Backup created: ${result.filename}`);
    } catch (error) {
        console.error('Error creating backup:', error);
        alert('Error creating backup: ' + error.message);
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
            alert('Backup restored successfully!');
            window.location.reload();
        }
    } catch (error) {
        console.error('Error restoring backup:', error);
        alert('Error restoring backup: ' + error.message);
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
    } catch (error) {
        console.error('Error deleting backup:', error);
        alert('Error deleting backup: ' + error.message);
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

    // Include images checkbox - update estimate when changed
    const includeImages = document.getElementById('backup-include-images');
    if (includeImages) {
        includeImages.addEventListener('change', updateBackupEstimate);
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
                    includeImages: includeImages?.checked ?? true,
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
            if (includeImages) includeImages.checked = settings.includeImages ?? true;
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
            saveScheduleSettings(true, includePatterns.checked ? 'Patterns will be included' : 'Patterns excluded from backup');
        });
    }

    if (includeImages) {
        includeImages.addEventListener('change', () => {
            saveScheduleSettings(true, includeImages.checked ? 'Images will be included' : 'Images excluded from backup');
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

async function loadOrphanedImagesCount() {
    const countEl = document.getElementById('orphaned-images-count');
    const descEl = document.getElementById('orphaned-images-desc');
    const listEl = document.getElementById('orphaned-images-list');
    const btn = document.getElementById('cleanup-images-btn');

    if (!countEl) return;

    try {
        const response = await fetch(`${API_URL}/api/images/orphaned`);
        const data = await response.json();

        if (data.count === 0) {
            countEl.textContent = 'No orphaned images';
            descEl.textContent = '— all images are in use';
            btn.style.display = 'none';
            if (listEl) listEl.innerHTML = '';
        } else {
            countEl.textContent = `${data.count} orphaned image${data.count === 1 ? '' : 's'}`;
            descEl.textContent = '— can be safely deleted';
            btn.style.display = 'block';
            if (listEl) {
                listEl.innerHTML = data.files.map(f => {
                    // Handle both object format {filename, patternName} and string format
                    const filename = typeof f === 'string' ? f : f.filename;
                    const patternName = typeof f === 'string' ? parsePatternFromFilename(f) : f.patternName;
                    return `<li><code>${escapeHtml(filename)}</code> <span class="setting-hint">from "${escapeHtml(patternName)}"</span></li>`;
                }).join('');
            }
        }
    } catch (error) {
        countEl.textContent = 'Could not check images';
        descEl.textContent = '';
        btn.style.display = 'none';
        if (listEl) listEl.innerHTML = '';
    }
}

async function cleanupOrphanedImages() {
    const btn = document.getElementById('cleanup-images-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Cleaning...';
    btn.disabled = true;

    try {
        const response = await fetch(`${API_URL}/api/images/cleanup`, {
            method: 'POST'
        });
        const data = await response.json();

        // Refresh the count
        await loadOrphanedImagesCount();

        // Show brief success message
        const countEl = document.getElementById('orphaned-images-count');
        countEl.textContent = `Deleted ${data.count} image${data.count === 1 ? '' : 's'}`;
        setTimeout(loadOrphanedImagesCount, 2000);
    } catch (error) {
        console.error('Error cleaning up images:', error);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

let cachedLibrarySize = 0;
let cachedImagesSize = 0;
let cachedImagesCount = 0;

async function loadLibrarySizeForBackup() {
    try {
        const response = await fetch(`${API_URL}/api/stats`);
        const stats = await response.json();
        cachedLibrarySize = stats.totalSize || 0;

        const sizeInfo = document.getElementById('library-size-info');
        if (sizeInfo) {
            const formattedSize = formatBackupSize(cachedLibrarySize);
            sizeInfo.textContent = `Pattern library is ${formattedSize}`;
        }
        // Update backup path display
        const pathDisplay = document.getElementById('backup-path-display');
        if (pathDisplay && stats.backupHostPath) {
            pathDisplay.textContent = stats.backupHostPath;
        }

        // Load images size
        await loadImagesSizeForBackup();

        // Update backup estimate
        updateBackupEstimate();
    } catch (error) {
        const sizeInfo = document.getElementById('library-size-info');
        if (sizeInfo) {
            sizeInfo.textContent = 'Could not load library size';
        }
    }
}

async function loadImagesSizeForBackup() {
    try {
        const response = await fetch(`${API_URL}/api/images/stats`);
        const stats = await response.json();
        cachedImagesSize = stats.totalSize || 0;
        cachedImagesCount = stats.count || 0;

        const sizeInfo = document.getElementById('images-size-info');
        if (sizeInfo) {
            const formattedSize = formatBackupSize(cachedImagesSize);
            sizeInfo.textContent = `${cachedImagesCount} image${cachedImagesCount === 1 ? '' : 's'} (${formattedSize})`;
        }

        // Update storage section
        const storageCount = document.getElementById('storage-images-count');
        const storageSize = document.getElementById('storage-images-size');
        if (storageCount) {
            storageCount.textContent = `${cachedImagesCount} image${cachedImagesCount === 1 ? '' : 's'}`;
        }
        if (storageSize) {
            storageSize.textContent = `— ${formatBackupSize(cachedImagesSize)} total`;
        }
    } catch (error) {
        const sizeInfo = document.getElementById('images-size-info');
        if (sizeInfo) {
            sizeInfo.textContent = 'Could not load images size';
        }
    }
}

function updateBackupEstimate() {
    const estimate = document.getElementById('backup-estimate');
    if (!estimate) return;

    const includePatterns = document.getElementById('backup-include-patterns');
    const includeImages = document.getElementById('backup-include-images');
    const dbEstimate = 50000; // ~50KB for database JSON

    let totalSize = dbEstimate;
    if (includePatterns && includePatterns.checked) {
        totalSize += cachedLibrarySize;
    }
    if (includeImages && includeImages.checked) {
        totalSize += cachedImagesSize;
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
                    ${!isDefault ? `<button class="btn btn-small btn-secondary" onclick="setDefaultCategory('${escapeHtml(category)}')" title="Set as default">★</button>` : ''}
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
        showToast('Category added');
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
        showToast('Category renamed');
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
        showToast('Hashtag added');
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
        showToast('Hashtag renamed');
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
}

function displayCurrentPatterns() {
    const grid = document.getElementById('current-patterns-grid');

    if (currentPatterns.length === 0) {
        grid.innerHTML = '<p class="empty-state">You don\'t have any active patterns. Time to start crocheting!</p>';
        return;
    }

    grid.innerHTML = currentPatterns.map(pattern => {
        const hashtags = pattern.hashtags || [];
        const hashtagsHtml = hashtags.length > 0
            ? `<div class="pattern-hashtags">${hashtags.map(h => `<span class="pattern-hashtag">#${escapeHtml(h.name)}</span>`).join('')}</div>`
            : '';

        const typeLabel = pattern.pattern_type === 'markdown' ? 'MD' : 'PDF';

        return `
            <div class="pattern-card" onclick="handlePatternClick(event, ${pattern.id})">
                ${showStatusBadge ? (pattern.completed ? '<span class="completed-badge">COMPLETE</span>' : '<span class="current-badge">CURRENT</span>') : ''}
                ${showCategoryBadge && pattern.category ? `<span class="category-badge-overlay">${escapeHtml(pattern.category)}</span>` : ''}
                ${showTypeBadge ? `<span class="type-badge">${typeLabel}</span>` : ''}
                ${pattern.is_favorite ? '<span class="favorite-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></span>' : ''}
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
                ${pattern.completed && pattern.completed_date
                    ? `<p class="completion-date">${new Date(pattern.completed_date).toLocaleDateString()}${pattern.timer_seconds > 0 ? ` · ${formatTime(pattern.timer_seconds)}` : ''}</p>`
                    : (pattern.timer_seconds > 0
                        ? `<p class="pattern-status elapsed">Elapsed: ${formatTime(pattern.timer_seconds)}</p>`
                        : `<p class="pattern-status new">New Pattern</p>`)}
                <p class="pattern-description" onclick="event.stopPropagation(); startInlineDescEdit(this, '${pattern.id}')" title="Click to edit">${pattern.description ? escapeHtml(pattern.description) : '<span class="add-description">+ Add description</span>'}</p>
                ${hashtagsHtml}
                <div class="pattern-actions" onclick="event.stopPropagation()">
                    <button class="action-btn ${pattern.is_favorite ? 'active favorite' : ''}"
                            onclick="toggleFavorite('${pattern.id}', ${!pattern.is_favorite})"
                            title="${pattern.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="${pattern.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                    </button>
                    <button class="action-btn ${pattern.is_current ? 'current' : ''}"
                            onclick="toggleCurrent('${pattern.id}', ${!pattern.is_current})"
                            title="${pattern.is_current ? 'Remove from Current' : 'Make Current'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="${pattern.is_current ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                    </button>
                    <button class="action-btn ${pattern.completed ? 'completed' : ''}"
                            onclick="toggleComplete('${pattern.id}', ${!pattern.completed})"
                            title="${pattern.completed ? 'Mark Incomplete' : 'Mark Complete'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${pattern.completed ? '3' : '2'}" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                    <button class="action-btn" onclick="openEditModal('${pattern.id}')" title="Edit">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="action-btn delete" onclick="handleCardDelete(this, '${pattern.id}')" title="Delete">
                        <svg class="trash-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        <svg class="confirm-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                </div>
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

    // Filter by pattern type (PDF/Markdown)
    filteredPatterns = filteredPatterns.filter(p => {
        const isPdf = p.pattern_type !== 'markdown';
        if (isPdf && !showPdf) return false;
        if (!isPdf && !showMarkdown) return false;
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

        const typeLabel = pattern.pattern_type === 'markdown' ? 'MD' : 'PDF';
        const isNewPattern = !pattern.completed && !pattern.timer_seconds;
        const shouldHighlight = (highlightMode === 'new' && isNewPattern) || (highlightMode === 'current' && pattern.is_current) || (highlightMode === 'favorites' && pattern.is_favorite);
        const highlightClass = shouldHighlight ? ' highlight-new' : '';

        return `
            <div class="pattern-card${highlightClass}" onclick="handlePatternClick(event, ${pattern.id})">
                ${showStatusBadge && pattern.completed ? '<span class="completed-badge">COMPLETE</span>' : ''}
                ${showStatusBadge && !pattern.completed && pattern.is_current ? '<span class="current-badge">CURRENT</span>' : ''}
                ${showCategoryBadge && pattern.category ? `<span class="category-badge-overlay">${escapeHtml(pattern.category)}</span>` : ''}
                ${showTypeBadge ? `<span class="type-badge">${typeLabel}</span>` : ''}
                ${pattern.is_favorite ? '<span class="favorite-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></span>' : ''}
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
                ${pattern.completed && pattern.completed_date
                    ? `<p class="completion-date">${new Date(pattern.completed_date).toLocaleDateString()}${pattern.timer_seconds > 0 ? ` · ${formatTime(pattern.timer_seconds)}` : ''}</p>`
                    : (pattern.timer_seconds > 0
                        ? `<p class="pattern-status elapsed">Elapsed: ${formatTime(pattern.timer_seconds)}</p>`
                        : `<p class="pattern-status new">New Pattern</p>`)}
                <p class="pattern-description" onclick="event.stopPropagation(); startInlineDescEdit(this, '${pattern.id}')" title="Click to edit">${pattern.description ? escapeHtml(pattern.description) : '<span class="add-description">+ Add description</span>'}</p>
                ${hashtagsHtml}
                <div class="pattern-actions" onclick="event.stopPropagation()">
                    <button class="action-btn ${pattern.is_favorite ? 'active favorite' : ''}"
                            onclick="toggleFavorite('${pattern.id}', ${!pattern.is_favorite})"
                            title="${pattern.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="${pattern.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                    </button>
                    <button class="action-btn ${pattern.is_current ? 'current' : ''}"
                            onclick="toggleCurrent('${pattern.id}', ${!pattern.is_current})"
                            title="${pattern.is_current ? 'Remove from Current' : 'Make Current'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="${pattern.is_current ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                    </button>
                    <button class="action-btn ${pattern.completed ? 'completed' : ''}"
                            onclick="toggleComplete('${pattern.id}', ${!pattern.completed})"
                            title="${pattern.completed ? 'Mark Incomplete' : 'Mark Complete'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${pattern.completed ? '3' : '2'}" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                    <button class="action-btn" onclick="openEditModal('${pattern.id}')" title="Edit">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="action-btn delete" onclick="handleCardDelete(this, '${pattern.id}')" title="Delete">
                        <svg class="trash-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        <svg class="confirm-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                </div>
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

async function toggleFavorite(id, isFavorite) {
    try {
        const response = await fetch(`${API_URL}/api/patterns/${id}/favorite`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isFavorite })
        });

        if (response.ok) {
            await loadPatterns();
            await loadCurrentPatterns();
        } else {
            const error = await response.json();
            console.error('Error updating favorite status:', error.error);
        }
    } catch (error) {
        console.error('Error toggling favorite status:', error);
    }
}

function handleCardDelete(btn, id) {
    // First click - show confirmation state
    if (!btn.classList.contains('confirm-delete')) {
        btn.classList.add('confirm-delete');
        btn.title = 'Click again to confirm';
        return;
    }

    // Second click - actually delete
    deletePattern(id);
}

function startInlineDescEdit(element, patternId) {
    // Don't start editing if already editing
    if (element.isContentEditable) return;

    const maxLen = 45;
    const currentText = element.querySelector('.add-description') ? '' : element.textContent;

    element.textContent = currentText;
    element.contentEditable = true;
    element.classList.add('editing');

    // Add character counter
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
                method: 'PUT',
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

function resetCardDeleteButtons() {
    document.querySelectorAll('.action-btn.delete.confirm-delete').forEach(btn => {
        btn.classList.remove('confirm-delete');
        btn.title = 'Delete';
    });
}

// Reset delete buttons when clicking elsewhere
document.addEventListener('click', (e) => {
    if (!e.target.closest('.action-btn.delete')) {
        resetCardDeleteButtons();
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

    // Pinch to zoom on PDF viewer
    const pdfWrapper = document.querySelector('.pdf-viewer-wrapper');
    let initialPinchDistance = null;
    let initialZoom = 1.0;

    pdfWrapper.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            initialPinchDistance = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            // Convert fit mode to actual scale for pinch calculations
            if (pdfZoomMode === 'fit') {
                initialZoom = pdfFitScale;
            } else if (pdfZoomMode === 'fit-width') {
                initialZoom = pdfFitWidthScale;
            } else {
                initialZoom = pdfZoomScale;
            }
        }
    }, { passive: true });

    pdfWrapper.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialPinchDistance) {
            const currentDistance = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            // Reduce sensitivity: scale factor is dampened
            const rawScale = currentDistance / initialPinchDistance;
            const dampenedScale = 1 + (rawScale - 1) * 0.3; // 30% of the raw change
            pdfZoomMode = 'manual';
            pdfZoomScale = Math.min(Math.max(initialZoom * dampenedScale, 0.1), 4.0);
            document.getElementById('zoom-level').value = `${Math.round(pdfZoomScale * 100)}%`;
        }
    }, { passive: true });

    pdfWrapper.addEventListener('touchend', (e) => {
        if (initialPinchDistance && e.touches.length < 2) {
            initialPinchDistance = null;
            renderPage(currentPageNum);
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
            pdfZoomScale = Math.min(Math.max(pdfZoomScale + delta, 0.1), 4.0);
            renderPage(currentPageNum);
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
        const isPdfViewerOpen = pdfViewerContainer.style.display === 'flex';
        const isMarkdownViewerOpen = markdownViewerContainer && markdownViewerContainer.style.display === 'flex';

        if (!isPdfViewerOpen && !isMarkdownViewerOpen) {
            return;
        }

        // Don't trigger if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
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
}

// Handle pattern card click - supports cmd/ctrl+click to open in new window
function handlePatternClick(event, patternId) {
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

        // Save viewing pattern to sessionStorage for refresh persistence
        sessionStorage.setItem('viewingPatternId', id);

        // Route to appropriate viewer based on pattern type
        if (pattern.pattern_type === 'markdown') {
            await openMarkdownViewer(pattern, false); // Don't push history again, already done above
            return;
        }

        currentPattern = pattern;
        currentPageNum = pattern.current_page || 1;

        // Apply default zoom setting
        const defaultZoom = localStorage.getItem('defaultPdfZoom') || 'fit';
        if (defaultZoom === 'fit') {
            pdfZoomMode = 'fit';
        } else if (defaultZoom === 'fit-width') {
            pdfZoomMode = 'fit-width';
        } else {
            pdfZoomMode = 'manual';
            pdfZoomScale = parseInt(defaultZoom) / 100;
        }

        // Load timer state
        loadPatternTimer(pattern);

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

        const wrapper = document.querySelector('.pdf-viewer-wrapper');
        const containerWidth = wrapper.clientWidth - 40;
        const containerHeight = wrapper.clientHeight - 40;
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
        } else if (pdfZoomMode === 'fit-width') {
            scale = pdfFitWidthScale;
        } else {
            scale = pdfZoomScale;
        }

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
}

function zoomOut() {
    // If in fit mode, convert to actual scale first
    if (pdfZoomMode === 'fit') {
        pdfZoomScale = pdfFitScale;
    } else if (pdfZoomMode === 'fit-width') {
        pdfZoomScale = pdfFitWidthScale;
    }
    pdfZoomMode = 'manual';
    pdfZoomScale = Math.max(pdfZoomScale - 0.1, 0.1);
    renderPage(currentPageNum);
}

function zoomFitPage() {
    pdfZoomMode = 'fit';
    renderPage(currentPageNum);
}

function zoom100() {
    // 100% = fit width to screen
    pdfZoomMode = 'fit-width';
    renderPage(currentPageNum);
}

function setZoomLevel(level) {
    pdfZoomMode = 'manual';
    pdfZoomScale = Math.min(Math.max(level, 0.1), 4.0);
    renderPage(currentPageNum);
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

    // Clear viewing pattern from sessionStorage
    sessionStorage.removeItem('viewingPatternId');

    // Reset state
    resetTimerState();
    currentPattern = null;
    pdfDoc = null;
    lastUsedCounterId = null;

    // Reload patterns for when we return to list view
    await loadCurrentPatterns();
    await loadPatterns();

    // Navigate back using history (this will hide the viewer and show tabs)
    navigateBack();
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
    const patternHashtags = currentPattern.hashtags || [];
    hashtagsContainer.innerHTML = createHashtagSelector('pdf-edit-hashtags', patternHashtags);

    // Set existing thumbnail in selector
    if (currentPattern.thumbnail) {
        setThumbnailSelectorImage('pdf-edit', `${API_URL}${currentPattern.thumbnail}`);
    } else {
        clearThumbnailSelector('pdf-edit');
    }

    // Set current toggle state
    document.getElementById('pdf-edit-is-current').checked = currentPattern.is_current || false;

    // Reset delete button state
    const deleteBtn = document.getElementById('delete-pdf-pattern');
    resetDeleteButton(deleteBtn, 'Delete Pattern');

    modal.style.display = 'flex';
}

function closePdfEditModal() {
    document.getElementById('pdf-edit-modal').style.display = 'none';
    // Reset delete button state
    const deleteBtn = document.getElementById('delete-pdf-pattern');
    resetDeleteButton(deleteBtn, 'Delete Pattern');
}

async function deletePdfPattern() {
    if (!currentPattern) return;

    const btn = document.getElementById('delete-pdf-pattern');

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
            closePdfEditModal();
            closePDFViewer();
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
            { label: 'Marked Current', value: info.is_current ? 'Yes' : 'No' },
            { label: 'File Size', value: formatFileSize(info.file_size) },
            { label: 'Filename', value: `<code>${escapeHtml(info.filename)}</code>` },
            { label: 'File Path', value: `<code>${escapeHtml(info.file_path)}</code>` }
        ];

        if (info.description) {
            rows.splice(2, 0, { label: 'Description', value: escapeHtml(info.description) });
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
        <div class="counter-item${lastUsedCounterId === counter.id ? ' active' : ''}" data-counter-id="${counter.id}" onclick="selectCounter(${counter.id})">
            <div class="counter-name">
                <input type="text" value="${escapeHtml(counter.name)}"
                       onchange="updateCounterName(${counter.id}, this.value)"
                       onclick="event.stopPropagation()"
                       placeholder="Counter name">
            </div>
            <div class="counter-value">${counter.value}</div>
            <div class="counter-controls">
                <button class="counter-btn counter-btn-minus" onclick="event.stopPropagation(); decrementCounter(${counter.id})">−</button>
                <button class="counter-btn counter-btn-plus" onclick="event.stopPropagation(); incrementCounter(${counter.id})">+</button>
                <button class="counter-btn counter-btn-reset" onclick="handleCounterReset(event, ${counter.id})" title="Click twice to reset">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                        <path d="M3 3v5h5"/>
                    </svg>
                </button>
                <button class="counter-btn counter-btn-delete" onclick="handleCounterDelete(event, ${counter.id})" title="Click twice to delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
}

function selectCounter(counterId) {
    lastUsedCounterId = counterId;
    displayCounters();
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

function selectNextCounter() {
    if (counters.length === 0) return;

    const currentIndex = counters.findIndex(c => c.id === lastUsedCounterId);
    const nextIndex = (currentIndex + 1) % counters.length;
    lastUsedCounterId = counters[nextIndex].id;
    displayCounters();
    displayMarkdownCounters();
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

    closeBtn.addEventListener('click', closeEditModal);
    cancelBtn.addEventListener('click', closeEditModal);
    deleteBtn.addEventListener('click', deleteEditPattern);

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

    const deleteMarkdownBtn = document.getElementById('delete-markdown-pattern');
    deleteMarkdownBtn.onclick = deleteMarkdownPattern;

    const editModal = document.getElementById('markdown-edit-modal');
    editModal.onclick = (e) => {
        if (e.target === editModal) closeMarkdownEditModal();
    };

    // Edit modal tabs
    const editTabs = document.querySelectorAll('.markdown-edit-tab');
    editTabs.forEach(tab => {
        tab.onclick = () => switchMarkdownEditTab(tab.dataset.tab);
    });

    // Live preview checkbox in edit modal
    const editLivePreviewCheckbox = document.getElementById('markdown-edit-live-preview');
    editLivePreviewCheckbox.onchange = (e) => {
        const body = document.querySelector('.markdown-edit-body');
        const preview = document.getElementById('markdown-edit-preview');
        const editContent = document.getElementById('markdown-edit-content');

        if (e.target.checked) {
            body.className = 'markdown-edit-body live-preview-mode';
            preview.innerHTML = renderMarkdown(editContent.value);
            // Update tabs to show neither is active
            editTabs.forEach(t => t.classList.remove('active'));
        } else {
            // Return to edit mode
            body.className = 'markdown-edit-body edit-mode';
            editTabs.forEach(t => {
                t.classList.toggle('active', t.dataset.tab === 'edit');
            });
        }
    };

    // Live preview in edit modal (update on input)
    const editContent = document.getElementById('markdown-edit-content');
    editContent.oninput = () => {
        document.getElementById('markdown-edit-preview').innerHTML = renderMarkdown(editContent.value);
    };
    // Enable auto-continue for lists and image paste
    setupMarkdownListContinuation(editContent);
    setupImagePaste(editContent, () => currentPattern?.name || 'pattern');
}

function switchMarkdownEditTab(tab) {
    const tabs = document.querySelectorAll('.markdown-edit-tab');
    const body = document.querySelector('.markdown-edit-body');
    const preview = document.getElementById('markdown-edit-preview');
    const editContent = document.getElementById('markdown-edit-content');
    const livePreviewCheckbox = document.getElementById('markdown-edit-live-preview');

    // Update active tab
    tabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });

    // Uncheck live preview when switching tabs
    livePreviewCheckbox.checked = false;

    if (tab === 'edit') {
        body.className = 'markdown-edit-body edit-mode';
    } else if (tab === 'preview') {
        body.className = 'markdown-edit-body preview-mode';
        preview.innerHTML = renderMarkdown(editContent.value);
    }
}

async function closeMarkdownViewer() {
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
    sessionStorage.removeItem('viewingPatternId');

    // Reset state
    resetTimerState();
    currentPattern = null;
    lastUsedCounterId = null;

    // Reload patterns for when we return to list view
    await loadCurrentPatterns();
    await loadPatterns();

    // Navigate back using history (this will hide the viewer and show tabs)
    navigateBack();
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
        <div class="counter-item${lastUsedCounterId === counter.id ? ' active' : ''}" data-counter-id="${counter.id}" onclick="selectCounter(${counter.id})">
            <div class="counter-name">
                <input type="text" value="${escapeHtml(counter.name)}"
                       onchange="updateCounterName(${counter.id}, this.value)"
                       onclick="event.stopPropagation()"
                       placeholder="Counter name">
            </div>
            <div class="counter-value">${counter.value}</div>
            <div class="counter-controls">
                <button class="counter-btn counter-btn-minus" onclick="event.stopPropagation(); decrementCounter(${counter.id})">−</button>
                <button class="counter-btn counter-btn-plus" onclick="event.stopPropagation(); incrementCounter(${counter.id})">+</button>
                <button class="counter-btn counter-btn-reset" onclick="handleCounterReset(event, ${counter.id})" title="Click twice to reset">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                        <path d="M3 3v5h5"/>
                    </svg>
                </button>
                <button class="counter-btn counter-btn-delete" onclick="handleCounterDelete(event, ${counter.id})" title="Click twice to delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
}

// Markdown edit modal
async function openMarkdownEditModal() {
    const modal = document.getElementById('markdown-edit-modal');
    const textarea = document.getElementById('markdown-edit-content');
    const preview = document.getElementById('markdown-edit-preview');
    const body = document.querySelector('.markdown-edit-body');
    const tabs = document.querySelectorAll('.markdown-edit-tab');
    const livePreviewCheckbox = document.getElementById('markdown-edit-live-preview');

    // Reset to edit mode
    body.className = 'markdown-edit-body edit-mode';
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'edit'));
    livePreviewCheckbox.checked = false;

    // Populate metadata sidebar
    document.getElementById('markdown-edit-name').value = currentPattern.name || '';
    document.getElementById('markdown-edit-description').value = currentPattern.description || '';

    // Populate category dropdown
    const categoryContainer = document.getElementById('markdown-edit-category-container');
    categoryContainer.innerHTML = createCategoryDropdown('markdown-edit-category', currentPattern.category || getDefaultCategory());

    // Populate hashtags selector
    const hashtagsContainer = document.getElementById('markdown-edit-hashtags-container');
    const patternHashtags = currentPattern.hashtags || [];
    hashtagsContainer.innerHTML = createHashtagSelector('markdown-edit-hashtags', patternHashtags);

    // Set existing thumbnail in selector
    if (currentPattern.thumbnail) {
        setThumbnailSelectorImage('markdown-edit', `${API_URL}${currentPattern.thumbnail}`);
    } else {
        clearThumbnailSelector('markdown-edit');
    }

    // Set current toggle state
    document.getElementById('markdown-edit-is-current').checked = currentPattern.is_current || false;

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
    const content = document.getElementById('markdown-edit-content').value;
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
            console.log('Uploading markdown edit thumbnail:', thumbnailFile.name, thumbnailFile.size, 'bytes');
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
        } else {
            console.log('No thumbnail file for markdown edit');
        }

        // Save the content
        const response = await fetch(`${API_URL}/api/patterns/${currentPattern.id}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });

        if (response.ok) {
            // Update the viewer
            document.getElementById('markdown-content').innerHTML = renderMarkdown(content);

            // Update currentPattern with new values
            currentPattern.name = name;
            currentPattern.category = category;
            currentPattern.description = description;
            currentPattern.is_current = isCurrent;

            // Update the viewer header
            document.getElementById('markdown-pattern-name').textContent = name;

            closeMarkdownEditModal();

            // Reload patterns to reflect changes in the library
            await loadPatterns();
            await loadCurrentPatterns();
            await loadCategories();
        } else {
            console.error('Error saving content');
            alert('Error saving content');
        }
    } catch (error) {
        console.error('Error saving pattern:', error);
        alert('Error saving pattern: ' + error.message);
    }
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
