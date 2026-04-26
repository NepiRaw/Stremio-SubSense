/**
 * SubSense Configuration Page Logic
 */

const MAX_LANGUAGES = 5;
const STORAGE_KEY = 'subsense_selected_languages';
const MAX_SUBTITLES_STORAGE_KEY = 'subsense_max_subtitles';
const KEEP_ASS_STORAGE_KEY = 'subsense_keep_ass';
const DEFAULT_MAX_SUBTITLES = 10;

let LANGUAGES = [
    { code: 'eng', name: 'English' },
    { code: 'fre', name: 'French' },
    { code: 'spa', name: 'Spanish' },
    { code: 'ger', name: 'German' },
    { code: 'ita', name: 'Italian' }
];

let selectedLanguages = [];
let selectedMaxSubtitles = DEFAULT_MAX_SUBTITLES;
let keepAss = false;
let highlightIndex = -1;
let subsourceApiKey = '';
let subsourceApiKeyValid = false;

const container = document.getElementById('multiselectContainer');
const inputWrapper = document.getElementById('inputWrapper');
const input = document.getElementById('languageInput');
const dropdown = document.getElementById('dropdownList');
const optionsList = document.getElementById('optionsList');
const dropdownStatus = document.getElementById('dropdownStatus');

const installBtn = document.getElementById('installBtn');
const installDropdownToggle = document.getElementById('installDropdownToggle');
const installDropdownMenu = document.getElementById('installDropdownMenu');
const installDirectly = document.getElementById('installDirectly');
const copyUrlBtn = document.getElementById('copyUrl');
const versionBadge = document.getElementById('versionBadge');
const toast = document.getElementById('toast');

const maxSubtitlesWrapper = document.getElementById('maxSubtitlesWrapper');
const maxSubtitlesTrigger = document.getElementById('maxSubtitlesTrigger');
const maxSubtitlesOptions = document.getElementById('maxSubtitlesOptions');
const maxSubtitlesText = document.getElementById('maxSubtitlesText');
const maxSubtitlesSelect = document.getElementById('maxSubtitlesSelect');

// SubSource API Key elements
const subsourceApiKeyInput = document.getElementById('subsourceApiKey');
const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');
const testSubsourceKeyBtn = document.getElementById('testSubsourceKey');
const subsourceApiStatus = document.getElementById('subsourceApiStatus');
const subsourceSourceItem = document.getElementById('subsourceSourceItem');

// Optional Sources expandable section
const optionalSourcesSection = document.getElementById('optionalSourcesSection');
const optionalSourcesToggle = document.getElementById('optionalSourcesToggle');

async function fetchLanguages() {
    try {
        const response = await fetch('/api/languages');
        if (response.ok) {
            const languages = await response.json();
            if (Array.isArray(languages) && languages.length > 0) {
                LANGUAGES = languages;
                console.log(`Loaded ${languages.length} languages from API`);
            }
        }
    } catch (error) {
        console.warn('Failed to fetch languages from API, using defaults:', error);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await Promise.all([
        fetchLanguages(),
        fetchVersion()
    ]);
    restoreSavedLanguages();
    restoreSavedMaxSubtitles();
    restoreSavedKeepAss();
    initSubsourceApiKey();
    renderOptions();
    setupEventListeners();
    updateInstallButtonState();
});

function saveLanguagesToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedLanguages));
    } catch (error) {
        console.warn('Failed to save languages to localStorage:', error);
    }
}

function saveMaxSubtitlesToStorage() {
    try {
        localStorage.setItem(MAX_SUBTITLES_STORAGE_KEY, selectedMaxSubtitles.toString());
    } catch (error) {
        console.warn('Failed to save max subtitles to localStorage:', error);
    }
}

function restoreSavedMaxSubtitles() {
    try {
        const saved = localStorage.getItem(MAX_SUBTITLES_STORAGE_KEY);
        if (saved !== null) {
            const parsed = parseInt(saved, 10);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
                selectedMaxSubtitles = parsed;
                updateMaxSubtitlesUI(parsed);
            }
        }
    } catch (error) {
        console.warn('Failed to restore max subtitles from localStorage:', error);
    }
}

function restoreSavedKeepAss() {
    try {
        keepAss = localStorage.getItem(KEEP_ASS_STORAGE_KEY) === 'true';
        const el = document.getElementById('keepAssToggle');
        if (el) el.checked = keepAss;
    } catch (error) {
        console.warn('Failed to restore keepAss from localStorage:', error);
    }
}

function updateMaxSubtitlesUI(value) {
    if (!maxSubtitlesText || !maxSubtitlesOptions || !maxSubtitlesSelect) return;
    
    maxSubtitlesText.textContent = value === 0 ? 'Unlimited' : value.toString();
    
    maxSubtitlesSelect.value = value.toString();
    
    const options = maxSubtitlesOptions.querySelectorAll('.custom-select-option');
    options.forEach(opt => {
        if (parseInt(opt.dataset.value, 10) === value) {
            opt.classList.add('selected');
        } else {
            opt.classList.remove('selected');
        }
    });
}

function restoreSavedLanguages() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) {
            const parsedLanguages = JSON.parse(saved);
            const validCodes = LANGUAGES.map(l => l.code);
            const validSaved = parsedLanguages
                .filter(code => validCodes.includes(code))
                .slice(0, MAX_LANGUAGES);
            
            validSaved.forEach(code => {
                selectedLanguages.push(code);
                addChip(code);
            });
        } else {
            selectLanguage('en');
        }
    } catch (error) {
        console.warn('Failed to restore languages from localStorage:', error);
        localStorage.removeItem(STORAGE_KEY);
        selectLanguage('en');
    }
}

async function fetchVersion() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        versionBadge.textContent = `v${data.version}`;
        
        if (!data.statsEnabled) {
            document.querySelectorAll('a[href="/stats"], a[href="/stats/content"]').forEach(el => {
                el.style.display = 'none';
            });
            
            const navLinks = document.querySelector('.nav-links');
            if (navLinks) {
                const visibleLinks = navLinks.querySelectorAll('a:not([style*="display: none"])');
                if (visibleLinks.length <= 1) {
                    navLinks.style.display = 'none';
                }
            }
        }

        if (data.userStats) {
            const headerMeta = document.querySelector('.header-meta');
            if (headerMeta) {
                const container = document.createElement('div');
                container.style.cssText = 'display:flex;gap:12px;align-items:center;margin-top:4px;font-size:0.75rem;';

                const activeBadge = document.createElement('span');
                activeBadge.style.cssText = 'display:flex;align-items:center;gap:4px;color:#a0a0a0;';
                activeBadge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;box-shadow:0 0 6px #4ade8099;"></span> ${data.userStats.activeUsers} active`;
                activeBadge.title = 'Active users in the last 15 minutes';

                const totalBadge = document.createElement('span');
                totalBadge.style.cssText = 'display:flex;align-items:center;gap:4px;color:#a0a0a0;';
                totalBadge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#6b7280;display:inline-block;"></span> ${data.userStats.totalUsers} users`;
                totalBadge.title = 'Unique users in the last 30 days';

                container.appendChild(activeBadge);
                container.appendChild(totalBadge);
                headerMeta.appendChild(container);
            }
        }
    } catch (error) {
        console.error('Failed to fetch config:', error);
        versionBadge.textContent = 'v?.?.?';
    }
}

function renderOptions(filterText = '') {
    optionsList.innerHTML = '';
    const lowerFilter = filterText.toLowerCase();
    
    const filtered = LANGUAGES.filter(lang => 
        lang.name.toLowerCase().includes(lowerFilter)
    );
    
    if (filtered.length === 0) {
        const noRes = document.createElement('div');
        noRes.className = 'option-item disabled';
        noRes.textContent = 'No languages found';
        noRes.style.cursor = 'default';
        noRes.style.color = 'var(--color-text-secondary)';
        optionsList.appendChild(noRes);
        return;
    }

    filtered.forEach(lang => {
        const isSelected = selectedLanguages.includes(lang.code);
        const item = document.createElement('div');
        item.className = `option-item ${isSelected ? 'selected' : ''}`;
        item.innerHTML = `
            <span>${lang.name}</span>
            <span class="check-mark">✓</span>
        `;
        
        if (isSelected) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                removeLanguageWithFlash(lang.code);
            });
            item.addEventListener('mouseenter', () => {
                document.querySelectorAll('.option-item').forEach(el => el.classList.remove('highlighted'));
                item.classList.add('highlighted');
            });
        } else {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectLanguage(lang.code);
            });
            item.addEventListener('mouseenter', () => {
                document.querySelectorAll('.option-item').forEach(el => el.classList.remove('highlighted'));
                item.classList.add('highlighted');
            });
        }
        
        optionsList.appendChild(item);
    });

    highlightIndex = -1;
    
    if (selectedLanguages.length >= MAX_LANGUAGES) {
        dropdownStatus.style.display = 'block';
        dropdownStatus.textContent = `Maximum limit reached (${MAX_LANGUAGES})`;
        dropdownStatus.style.color = 'var(--color-text-secondary)';
    } else {
        dropdownStatus.style.display = 'none';
    }
}

function selectLanguage(code) {
    if (selectedLanguages.length >= MAX_LANGUAGES) {
        showToast(`Maximum ${MAX_LANGUAGES} languages allowed`, 'error');
        return;
    }
    
    if (!selectedLanguages.includes(code)) {
        selectedLanguages.push(code);
        addChip(code);
        saveLanguagesToStorage();
        updateInstallButtonState();
        input.value = '';
        input.focus();
        renderOptions();
        
        if (selectedLanguages.length >= MAX_LANGUAGES) {
            closeDropdown();
        }
    }
}

function addChip(code) {
    const lang = LANGUAGES.find(l => l.code === code);
    if (!lang) return;

    const chip = document.createElement('div');
    chip.className = 'multi-select-chip';
    chip.dataset.code = code;
    chip.innerHTML = `
        ${lang.name}
        <button class="remove-chip" onclick="removeLanguage('${code}')">×</button>
    `;
    
    inputWrapper.insertBefore(chip, input);
}

function removeLanguage(code) {
    const index = selectedLanguages.indexOf(code);
    if (index > -1) {
        selectedLanguages.splice(index, 1);
        
        const chip = inputWrapper.querySelector(`.multi-select-chip[data-code="${code}"]`);
        if (chip) chip.remove();
        
        saveLanguagesToStorage();
        updateInstallButtonState();
        renderOptions(input.value);
    }
}

function removeLanguageWithFlash(code) {
    const chip = inputWrapper.querySelector(`.multi-select-chip[data-code="${code}"]`);
    if (chip) {
        chip.classList.add('flash-remove');
        
        setTimeout(() => {
            removeLanguage(code);
        }, 300);
    } else {
        removeLanguage(code);
    }
}

function handleInputKeydown(e) {
    const items = optionsList.querySelectorAll('.option-item:not(.selected):not(.disabled)');
    
    if (e.key === 'Backspace' && input.value === '') {
        if (selectedLanguages.length > 0) {
            removeLanguage(selectedLanguages[selectedLanguages.length - 1]);
        }
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        openDropdown();
        if (highlightIndex < items.length - 1) {
            highlightIndex++;
            updateHighlight(items);
        }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (highlightIndex > 0) {
            highlightIndex--;
            updateHighlight(items);
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIndex >= 0 && items[highlightIndex]) {
            items[highlightIndex].click();
        } else if (items.length > 0 && input.value !== '') {
            items[0].click();
        }
    } else if (e.key === 'Escape') {
        closeDropdown();
    }
}

function updateHighlight(items) {
    items.forEach((item, index) => {
        if (index === highlightIndex) {
            item.classList.add('highlighted');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('highlighted');
        }
    });
}

function setupEventListeners() {
    inputWrapper.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-chip')) {
            input.focus();
            openDropdown();
        }
    });

    input.addEventListener('focus', openDropdown);
    input.addEventListener('input', (e) => {
        openDropdown();
        renderOptions(e.target.value);
    });
    input.addEventListener('keydown', handleInputKeydown);

    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            closeDropdown();
        }
        
        if (!installDropdownToggle.contains(e.target) && !installDropdownMenu.contains(e.target)) {
            closeInstallDropdown();
        }
    });

    installDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        installDropdownMenu.classList.toggle('show');
        installDropdownToggle.classList.toggle('active');
    });

    if (maxSubtitlesTrigger && maxSubtitlesOptions) {
        maxSubtitlesTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            maxSubtitlesWrapper.classList.toggle('active');
            maxSubtitlesTrigger.classList.toggle('active');
            maxSubtitlesOptions.classList.toggle('show');
        });
        
        const options = maxSubtitlesOptions.querySelectorAll('.custom-select-option');
        options.forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = parseInt(opt.dataset.value, 10);
                selectedMaxSubtitles = value;
                updateMaxSubtitlesUI(value);
                saveMaxSubtitlesToStorage();
                
                maxSubtitlesWrapper.classList.remove('active');
                maxSubtitlesTrigger.classList.remove('active');
                maxSubtitlesOptions.classList.remove('show');
            });
        });
        
        document.addEventListener('click', (e) => {
            if (!maxSubtitlesWrapper.contains(e.target)) {
                maxSubtitlesWrapper.classList.remove('active');
                maxSubtitlesTrigger.classList.remove('active');
                maxSubtitlesOptions.classList.remove('show');
            }
        });
    }

    installBtn.addEventListener('click', installAddon);
    installDirectly.addEventListener('click', installAddon);
    copyUrlBtn.addEventListener('click', copyManifestUrl);

    const keepAssEl = document.getElementById('keepAssToggle');
    if (keepAssEl) {
        keepAssEl.addEventListener('change', () => {
            keepAss = !!keepAssEl.checked;
            try { localStorage.setItem(KEEP_ASS_STORAGE_KEY, String(keepAss)); } catch (_) { /* ignore */ }
        });
    }
}

function openDropdown() {
    container.classList.add('active');
}

function closeDropdown() {
    container.classList.remove('active');
    highlightIndex = -1;
}

function closeInstallDropdown() {
    installDropdownMenu.classList.remove('show');
    installDropdownToggle.classList.remove('active');
}

function updateInstallButtonState() {
    const isEnabled = selectedLanguages.length > 0;
    installBtn.disabled = !isEnabled;
    installDropdownToggle.disabled = !isEnabled;
}

function generateUserId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let userId = '';
    for (let i = 0; i < 8; i++) {
        userId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return userId;
}

function getManifestUrl() {
    const config = {
        languages: selectedLanguages
    };
    
    if (selectedMaxSubtitles > 0) {
        config.maxSubtitles = selectedMaxSubtitles;
    }
    if (keepAss) config.keepAss = true;
    
    const userId = generateUserId();
    const configString = encodeURIComponent(JSON.stringify(config));
    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
    
    return `${protocol}://${host}/${userId}-${configString}/manifest.json`;
}

async function getManifestUrlWithApiKeys() {
    const userId = generateUserId();
    const configString = await getEncryptedConfig();
    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
    
    return `${protocol}://${host}/${userId}-${configString}/manifest.json`;
}

function getStremioUrl() {
    const config = {
        languages: selectedLanguages
    };
    
    if (selectedMaxSubtitles > 0) {
        config.maxSubtitles = selectedMaxSubtitles;
    }
    if (keepAss) config.keepAss = true;
    
    const userId = generateUserId();
    const configString = encodeURIComponent(JSON.stringify(config));
    const host = window.location.host;
    
    return `stremio://${host}/${userId}-${configString}/manifest.json`;
}

async function getStremioUrlWithApiKeys() {
    const userId = generateUserId();
    const configString = await getEncryptedConfig();
    const host = window.location.host;
    
    return `stremio://${host}/${userId}-${configString}/manifest.json`;
}

async function installAddon() {
    if (selectedLanguages.length === 0) {
        showToast('Please select at least one language', 'error');
        return;
    }
    
    const originalContent = installBtn.innerHTML;
    installBtn.disabled = true;
    installBtn.innerHTML = `
        <span class="spinner"></span>
        Opening Stremio...
    `;
    installBtn.classList.add('success');
    
    installDropdownToggle.disabled = true;
    
    // Use async version if API keys are configured
    const stremioUrl = subsourceApiKeyValid ? 
        await getStremioUrlWithApiKeys() : 
        getStremioUrl();
    
    setTimeout(() => {
        window.location.href = stremioUrl;
        
        setTimeout(() => {
            installBtn.innerHTML = originalContent;
            installBtn.disabled = false;
            installBtn.classList.remove('success');
            installDropdownToggle.disabled = false;
        }, 3000);
    }, 800);
}

async function copyManifestUrl() {
    if (selectedLanguages.length === 0) {
        showToast('Please select at least one language', 'error');
        return;
    }
    
    // Use async version if API keys are configured
    const url = subsourceApiKeyValid ? 
        await getManifestUrlWithApiKeys() : 
        getManifestUrl();
    
    try {
        await navigator.clipboard.writeText(url);
        showToast('URL copied to clipboard!');
    } catch (error) {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('URL copied to clipboard!');
    }
    
    closeInstallDropdown();
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.style.background = type === 'error' ? 'var(--color-error)' : 'var(--color-success)';
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// ===== SubSource API Key Functions =====

const EYE_OPEN_PATH = 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z';
const EYE_CLOSED_PATH = 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z';

function initSubsourceApiKey() {
    if (optionalSourcesToggle && optionalSourcesSection) {
        optionalSourcesToggle.addEventListener('click', () => {
            optionalSourcesSection.classList.toggle('expanded');
        });
    }
    
    if (toggleApiKeyVisibility) {
        toggleApiKeyVisibility.addEventListener('click', () => {
            const isPassword = subsourceApiKeyInput.type === 'password';
            subsourceApiKeyInput.type = isPassword ? 'text' : 'password';
            const eyeIcon = document.getElementById('eyeIcon');
            if (eyeIcon) {
                const pathEl = eyeIcon.querySelector('path');
                if (pathEl) {
                    pathEl.setAttribute('d', isPassword ? EYE_CLOSED_PATH : EYE_OPEN_PATH);
                }
            }
        });
    }
    
    if (testSubsourceKeyBtn) {
        testSubsourceKeyBtn.addEventListener('click', () => {
            const key = subsourceApiKeyInput.value.trim();
            if (key) {
                validateSubsourceApiKey(key, false);
            } else {
                updateSubsourceStatus('unconfigured', 'Enter an API key to enable SubSource');
            }
        });
    }
    
    if (subsourceApiKeyInput) {
        subsourceApiKeyInput.addEventListener('input', () => {
            const key = subsourceApiKeyInput.value.trim();
            if (!key) {
                subsourceApiKey = '';
                subsourceApiKeyValid = false;
                updateSubsourceStatus('unconfigured', 'Enter an API key to enable SubSource');
                setTestButtonBreathing(false);
                updateSubsourceSourceVisibility();
            } else if (!subsourceApiKeyValid || key !== subsourceApiKey) {
                subsourceApiKeyValid = false;
                updateSubsourceStatus('pending', 'Click Test to validate your API key');
                setTestButtonBreathing(true);
                updateSubsourceSourceVisibility();
            }
        });
    }
}

function setTestButtonBreathing(enabled) {
    if (!testSubsourceKeyBtn) return;
    if (enabled) {
        testSubsourceKeyBtn.classList.add('breathing');
    } else {
        testSubsourceKeyBtn.classList.remove('breathing');
    }
}

async function validateSubsourceApiKey(apiKey, silent = false) {
    if (!silent) {
        updateSubsourceStatus('testing', 'Validating API key...');
        if (testSubsourceKeyBtn) testSubsourceKeyBtn.disabled = true;
        setTestButtonBreathing(false);
    }
    
    try {
        const response = await fetch('/api/subsource/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });
        
        const result = await response.json();
        
        if (result.valid) {
            subsourceApiKey = apiKey;
            subsourceApiKeyValid = true;
            updateSubsourceStatus('valid', 'API key is valid ✓');
            if (!silent) showToast('SubSource API key validated!');
        } else {
            subsourceApiKey = '';
            subsourceApiKeyValid = false;
            updateSubsourceStatus('invalid', result.error || 'Invalid API key');
            if (!silent) showToast('Invalid API key', 'error');
        }
    } catch (error) {
        console.error('Failed to validate SubSource API key:', error);
        updateSubsourceStatus('invalid', 'Failed to validate - check connection');
        if (!silent) showToast('Failed to validate API key', 'error');
    } finally {
        if (testSubsourceKeyBtn) testSubsourceKeyBtn.disabled = false;
        updateSubsourceSourceVisibility();
    }
}

function updateSubsourceStatus(status, message) {
    if (!subsourceApiStatus) return;
    
    subsourceApiStatus.className = `api-status ${status}`;
    const statusText = subsourceApiStatus.querySelector('.status-text');
    if (statusText) {
        statusText.textContent = message;
    }
}

function updateSubsourceSourceVisibility() {
    if (subsourceSourceItem) {
        subsourceSourceItem.style.display = subsourceApiKeyValid ? 'flex' : 'none';
    }
}

async function getEncryptedConfig() {
    const config = {
        languages: selectedLanguages
    };
    
    if (selectedMaxSubtitles > 0) {
        config.maxSubtitles = selectedMaxSubtitles;
    }
    if (keepAss) config.keepAss = true;
    
    if (subsourceApiKey && subsourceApiKeyValid) {
        config.subsourceApiKey = subsourceApiKey;
    }
    
    if (config.subsourceApiKey) {
        try {
            const response = await fetch('/api/config/encrypt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config })
            });
            
            if (response.ok) {
                const result = await response.json();
                return result.encrypted;
            }
        } catch (error) {
            console.error('Failed to encrypt config:', error);
        }
    }
    
    const safeConfig = {
        languages: selectedLanguages
    };
    if (selectedMaxSubtitles > 0) {
        safeConfig.maxSubtitles = selectedMaxSubtitles;
    }
    if (keepAss) safeConfig.keepAss = true;
    return encodeURIComponent(JSON.stringify(safeConfig));
}

window.removeLanguage = removeLanguage;