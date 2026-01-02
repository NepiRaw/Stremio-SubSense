/**
 * SubSense Statistics Dashboard Logic
 */

let sourceChart = null;
let langChart = null;
let timingChart = null;
let refreshInterval = null;

const REFRESH_INTERVAL_MS = 30000; // 30 seconds

// Chart colors - Modern Gradient Palette
const CHART_COLORS = [
    '#4A90E2', '#6BA5E7', '#89B9EC', '#A7CEF1',  // Blues
    '#9B59B6', '#B07CC6', '#C59FD6', '#DAC2E6',  // Purples
    '#2ECC71', '#58D68D', '#82E0A9', '#ABEDC5',  // Greens
    '#E74C3C', '#ED7669', '#F3A096', '#F9CAC3',  // Reds
    '#F39C12', '#F6B93B', '#F9D56E', '#FCF1A1',  // Oranges/Yellows
    '#1ABC9C', '#48C9B0', '#76D7C4', '#A3E4D7'   // Teals
];

// Configuration for language chart
let topLanguagesCount = 10;
const MIN_LANGUAGES = 3;
const MAX_LANGUAGES = 20;

// Store last stats for re-rendering
let lastStats = null;
const CHART_GRADIENTS = {
    source: ['#4A90E2', '#9B59B6', '#2ECC71', '#E74C3C', '#F39C12', '#1ABC9C'],
    language: ['#6BA5E7', '#B07CC6', '#58D68D', '#ED7669', '#F6B93B', '#48C9B0']
};

// Chart.js plugin for center text in doughnut
const centerTextPlugin = {
    id: 'centerText',
    beforeDraw: function(chart) {
        if (chart.config.type !== 'doughnut') return;
        if (!chart.config.options.plugins.centerText) return;
        
        const { ctx } = chart;
        const { chartArea } = chart;
        if (!chartArea) return;
        
        const centerConfig = chart.config.options.plugins.centerText;
        
        // Calculate center of the chart area
        const centerX = (chartArea.left + chartArea.right) / 2;
        const centerY = (chartArea.top + chartArea.bottom) / 2;
        
        ctx.save();
        
        // Draw total value
        const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
        ctx.font = 'bold 22px Inter, sans-serif';
        ctx.fillStyle = '#E8EDF5';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(total.toLocaleString(), centerX, centerY - 6);
        
        // Draw label
        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = '#9CA8C8';
        ctx.fillText(centerConfig.label || 'Total', centerX, centerY + 14);
        
        ctx.restore();
    }
};

// Register the plugin
Chart.register(centerTextPlugin);

/**
 * Re-check truncation after content update
 * Adds click-to-expand and hover tooltip for truncated cells
 * @param {HTMLElement} container - The container element to check within
 */
function refreshTruncatedCells(container = document) {
    const cells = container.querySelectorAll('.data-table td');
    cells.forEach(cell => {
        // Skip cells with buttons or special content
        if (cell.querySelector('button, code')) return;
        
        // Remove previous state
        cell.classList.remove('truncated', 'expanded');
        cell.removeAttribute('data-fulltext');
        
        // Re-check if truncated
        if (cell.scrollWidth > cell.clientWidth) {
            const fullText = cell.textContent.trim();
            cell.classList.add('truncated');
            cell.setAttribute('data-fulltext', fullText);
            cell.setAttribute('title', fullText); // Add native tooltip for hover
            
            // Add click handler if not already present
            if (!cell.hasAttribute('data-click-handler')) {
                cell.setAttribute('data-click-handler', 'true');
                cell.addEventListener('click', function(e) {
                    e.stopPropagation();
                    this.classList.toggle('expanded');
                });
            }
        }
    });
}

/**
 * Initialize the dashboard
 */
document.addEventListener('DOMContentLoaded', () => {
    fetchVersion();
    initCharts();
    setupLimitSelector();
    loadStats();
    setupAutoRefresh();
});

/**
 * Fetch version from API
 */
async function fetchVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        const version = `v${data.version}`;
        
        const versionBadge = document.getElementById('versionBadge');
        const footerVersion = document.getElementById('footerVersion');
        
        if (versionBadge) versionBadge.textContent = version;
        if (footerVersion) footerVersion.textContent = version;
    } catch (error) {
        console.error('Failed to fetch version:', error);
    }
}

/**
 * Initialize empty charts
 */
function initCharts() {
    // Common doughnut options with center text
    const doughnutOptions = {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1.5,
        cutout: '70%',
        plugins: {
            legend: {
                position: 'right',
                labels: { 
                    color: '#E8EDF5',
                    font: { size: 11, weight: '500' },
                    padding: 12,
                    usePointStyle: true,
                    pointStyle: 'circle'
                }
            },
            tooltip: {
                backgroundColor: 'rgba(26, 34, 63, 0.95)',
                titleColor: '#E8EDF5',
                bodyColor: '#9CA8C8',
                borderColor: 'rgba(74, 144, 226, 0.3)',
                borderWidth: 1,
                padding: 12,
                cornerRadius: 8,
                displayColors: true,
                boxPadding: 6,
                callbacks: {
                    label: function(context) {
                        const total = context.dataset.data.reduce((a, b) => a + b, 0);
                        const value = context.raw;
                        const percentage = ((value / total) * 100).toFixed(1);
                        return ` ${context.label}: ${value.toLocaleString()} (${percentage}%)`;
                    }
                }
            },
            centerText: {
                label: 'Total'
            }
        },
        elements: {
            arc: {
                borderWidth: 2,
                borderColor: 'rgba(12, 18, 38, 0.8)',
                borderRadius: 4
            }
        }
    };

    // Source distribution (doughnut with center total)
    const sourceCtx = document.getElementById('sourceChart').getContext('2d');
    sourceChart = new Chart(sourceCtx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: CHART_GRADIENTS.source,
                hoverOffset: 8
            }]
        },
        options: {
            ...doughnutOptions,
            plugins: {
                ...doughnutOptions.plugins,
                centerText: { label: 'Subtitles' }
            }
        }
    });

    // Language distribution (Horizontal Bar Chart - more readable for many languages)
    const langCtx = document.getElementById('langChart').getContext('2d');
    langChart = new Chart(langCtx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Subtitles',
                data: [],
                backgroundColor: 'rgba(74, 144, 226, 0.6)',
                hoverBackgroundColor: 'rgba(74, 144, 226, 0.8)',
                borderColor: 'rgba(74, 144, 226, 1)',
                borderWidth: 1,
                borderRadius: 4,
                borderSkipped: false
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 1.5,
            animation: {
                duration: 300
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 34, 63, 0.95)',
                    titleColor: '#E8EDF5',
                    bodyColor: '#9CA8C8',
                    borderColor: 'rgba(74, 144, 226, 0.3)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return ` ${context.raw.toLocaleString()} subtitles`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 10 }
                    },
                    grid: { 
                        color: 'rgba(74, 144, 226, 0.1)',
                        drawBorder: false
                    }
                },
                y: {
                    ticks: { 
                        color: '#E8EDF5',
                        font: { size: 11, weight: '500' }
                    },
                    grid: { 
                        display: false
                    }
                }
            },
            // Prevent resize on hover
            onHover: null
        }
    });

    // Timing chart (line) - Enhanced styling
    const timingCtx = document.getElementById('timingChart').getContext('2d');
    
    // Create gradient for line chart
    const timingGradient = timingCtx.createLinearGradient(0, 0, 0, 200);
    timingGradient.addColorStop(0, 'rgba(74, 144, 226, 0.4)');
    timingGradient.addColorStop(1, 'rgba(74, 144, 226, 0.02)');
    
    timingChart = new Chart(timingCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Fetch Time (ms)',
                data: [],
                borderColor: '#4A90E2',
                backgroundColor: timingGradient,
                fill: true,
                tension: 0.4,
                borderWidth: 3,
                pointBackgroundColor: '#4A90E2',
                pointBorderColor: '#0C1226',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#6BA5E7',
                pointHoverBorderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 11 }
                    },
                    grid: { 
                        color: 'rgba(74, 144, 226, 0.1)',
                        drawBorder: false
                    }
                },
                x: {
                    ticks: { 
                        color: '#9CA8C8',
                        font: { size: 11 }
                    },
                    grid: { 
                        color: 'rgba(74, 144, 226, 0.1)',
                        drawBorder: false
                    }
                }
            },
            plugins: {
                legend: {
                    labels: { 
                        color: '#E8EDF5',
                        font: { weight: '500' }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 34, 63, 0.95)',
                    titleColor: '#E8EDF5',
                    bodyColor: '#9CA8C8',
                    borderColor: 'rgba(74, 144, 226, 0.3)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8
                }
            }
        }
    });
}

/**
 * Fetch and display stats
 */
async function loadStats() {
    try {
        // Load main stats
        const response = await fetch('/stats/json');
        const stats = await response.json();
        
        updateOverview(stats);
        updateLanguageMatching(stats);
        updateCharts(stats);
        updateDailyTable(stats);
        updateErrorsTable(stats);
        updateLastUpdated();
        
        // Load cache stats
        loadCacheStats();
        
        // Load provider stats
        loadProviderStats();
        
        // Initialize truncated cell expand functionality
        setTimeout(() => refreshTruncatedCells(), 100);
        
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

/**
 * Update overview stat cards
 */
function updateOverview(stats) {
    document.getElementById('totalRequests').textContent = stats.requests.total.toLocaleString();
    document.getElementById('movieRequests').textContent = stats.requests.movie.toLocaleString();
    document.getElementById('seriesRequests').textContent = stats.requests.series.toLocaleString();
    document.getElementById('totalSubtitles').textContent = stats.subtitles.total.toLocaleString();
    document.getElementById('avgFetchTime').textContent = `${stats.timing.avgMs}ms`;
    document.getElementById('uptime').textContent = stats.uptime.formatted;
}

/**
 * Update language matching stats
 */
function updateLanguageMatching(stats) {
    const lm = stats.languageMatching || {};
    
    document.getElementById('primarySuccessRate').textContent = `${lm.primarySuccessRate || 0}%`;
    document.getElementById('primaryFound').textContent = (lm.primaryFound || 0).toLocaleString();
    document.getElementById('combinedSuccessRate').textContent = `${lm.preferredSuccessRate || 0}%`;
    
    // Top successful languages
    const topLangsContainer = document.getElementById('topLanguages');
    const langSuccess = lm.byLanguageSuccess || {};
    const sorted = Object.entries(langSuccess)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
    
    if (sorted.length > 0) {
        topLangsContainer.innerHTML = sorted.map(([lang, count]) => 
            `<span class="language-tag">${lang.toUpperCase()}: ${count}</span>`
        ).join('');
    } else {
        topLangsContainer.innerHTML = '<span style="color: var(--text-muted);">No data yet</span>';
    }
}

/**
 * Update charts with new data
 */
function updateCharts(stats) {
    // Store stats for re-rendering when limit changes
    lastStats = stats;
    
    // Source chart (doughnut with center total)
    const sourceLabels = Object.keys(stats.subtitles.bySource);
    const sourceData = Object.values(stats.subtitles.bySource);
    sourceChart.data.labels = sourceLabels.length > 0 ? sourceLabels : ['No data'];
    sourceChart.data.datasets[0].data = sourceData.length > 0 ? sourceData : [1];
    // Use cycling colors if more than 6 sources
    sourceChart.data.datasets[0].backgroundColor = sourceLabels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);
    sourceChart.update();

    // Update language chart with current limit
    updateLanguageChart(stats);

    // Timing chart
    const timingHistory = stats.timing.recentHistory || [];
    timingChart.data.labels = timingHistory.map((_, i) => `#${i + 1}`);
    timingChart.data.datasets[0].data = timingHistory;
    timingChart.update();
}

/**
 * Update language chart with current top limit
 */
function updateLanguageChart(stats) {
    if (!stats) return;
    
    // Language chart (horizontal bar) - Top N languages sorted by count
    const langEntries = Object.entries(stats.subtitles.byLanguage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topLanguagesCount);
    const langLabels = langEntries.map(e => e[0].toUpperCase());
    const langData = langEntries.map(e => e[1]);
    
    // Update chart title
    const langChartTitle = document.getElementById('langChartTitle');
    if (langChartTitle) {
        langChartTitle.textContent = `Subtitles by Language (Top ${topLanguagesCount})`;
    }
    
    // Update limit display
    const limitValue = document.getElementById('limitValue');
    if (limitValue) {
        limitValue.textContent = topLanguagesCount;
    }
    
    // Update button states
    updateLimitButtons();
    
    // Create gradient colors based on position
    const langColors = langEntries.map((_, i) => {
        const opacity = 1 - (i * 0.04);
        return `rgba(74, 144, 226, ${Math.max(opacity, 0.3)})`;
    });
    
    langChart.data.labels = langLabels.length > 0 ? langLabels : ['No data'];
    langChart.data.datasets[0].data = langData.length > 0 ? langData : [0];
    langChart.data.datasets[0].backgroundColor = langColors;
    langChart.data.datasets[0].hoverBackgroundColor = langColors.map(c => c.replace(/[\d.]+\)$/, '1)'));
    langChart.update();
}

/**
 * Setup limit selector buttons
 */
function setupLimitSelector() {
    const decreaseBtn = document.getElementById('decreaseLimit');
    const increaseBtn = document.getElementById('increaseLimit');
    
    if (decreaseBtn) {
        decreaseBtn.addEventListener('click', () => {
            if (topLanguagesCount > MIN_LANGUAGES) {
                topLanguagesCount--;
                if (lastStats) updateLanguageChart(lastStats);
            }
        });
    }
    
    if (increaseBtn) {
        increaseBtn.addEventListener('click', () => {
            if (topLanguagesCount < MAX_LANGUAGES) {
                topLanguagesCount++;
                if (lastStats) updateLanguageChart(lastStats);
            }
        });
    }
    
    updateLimitButtons();
}

/**
 * Update limit button states
 */
function updateLimitButtons() {
    const decreaseBtn = document.getElementById('decreaseLimit');
    const increaseBtn = document.getElementById('increaseLimit');
    
    if (decreaseBtn) {
        decreaseBtn.disabled = topLanguagesCount <= MIN_LANGUAGES;
    }
    if (increaseBtn) {
        increaseBtn.disabled = topLanguagesCount >= MAX_LANGUAGES;
    }
}

/**
 * Update daily activity table
 */
function updateDailyTable(stats) {
    const tbody = document.querySelector('#dailyTable tbody');
    tbody.innerHTML = '';

    const byDate = stats.requests.byDate || {};
    const dates = Object.keys(byDate).sort().reverse().slice(0, 7); // Last 7 days

    if (dates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No activity yet</td></tr>';
        return;
    }

    dates.forEach(date => {
        const data = byDate[date];
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${formatDate(date)}</td>
            <td>${data.total}</td>
            <td>${data.movie || 0}</td>
            <td>${data.series || 0}</td>
        `;
        tbody.appendChild(row);
    });
}

/**
 * Update errors table
 */
function updateErrorsTable(stats) {
    const card = document.getElementById('errorsCard');
    const tbody = document.querySelector('#errorsTable tbody');
    
    const errors = stats.errors.recent || [];
    
    if (errors.length === 0) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    tbody.innerHTML = '';

    errors.reverse().forEach(error => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${formatTime(error.timestamp)}</td>
            <td>${escapeHtml(error.message)}</td>
        `;
        tbody.appendChild(row);
    });
}

/**
 * Setup auto-refresh
 */
function setupAutoRefresh() {
    const toggle = document.getElementById('autoRefresh');
    
    // Start auto-refresh
    startAutoRefresh();

    toggle.addEventListener('change', () => {
        if (toggle.checked) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
}

function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(loadStats, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

/**
 * Update last updated timestamp
 */
function updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    el.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    // Use local date for comparison (YYYY-MM-DD)
    const getLocalDateStr = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    if (dateStr === getLocalDateStr(today)) return 'Today';
    if (dateStr === getLocalDateStr(yesterday)) return 'Yesterday';
    
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// =====================================================
// Cache Stats
// =====================================================

/**
 * Load and display cache statistics
 */
async function loadCacheStats() {
    try {
        const response = await fetch('/api/stats/cache');
        
        if (!response.ok) {
            console.log('Cache stats not available');
            return;
        }
        
        const cache = await response.json();
        
        // Update cache stat cards
        const hitRateEl = document.getElementById('cacheHitRate');
        const entriesEl = document.getElementById('cacheEntries');
        const contentEl = document.getElementById('cacheContent');
        const languagesEl = document.getElementById('cacheLanguages');
        const sizeEl = document.getElementById('cacheSize');
        const hitBarEl = document.getElementById('cacheHitBar');
        const hitsEl = document.getElementById('cacheHits');
        const missesEl = document.getElementById('cacheMisses');
        
        if (hitRateEl) hitRateEl.textContent = `${cache.hitRate}%`;
        if (entriesEl) entriesEl.textContent = cache.entries.toLocaleString();
        if (contentEl) contentEl.textContent = cache.uniqueContent.toLocaleString();
        if (languagesEl) languagesEl.textContent = cache.uniqueLanguages;
        if (sizeEl) sizeEl.textContent = `${cache.sizeMB} MB`;
        if (hitBarEl) hitBarEl.style.width = `${cache.hitRate}%`;
        if (hitsEl) hitsEl.textContent = cache.hits.toLocaleString();
        if (missesEl) missesEl.textContent = cache.misses.toLocaleString();
        
    } catch (error) {
        console.error('Failed to load cache stats:', error);
    }
}

// =====================================================
// Provider Stats
// =====================================================

/**
 * Load and display provider statistics
 */
async function loadProviderStats() {
    try {
        const response = await fetch('/api/stats/providers');
        
        if (!response.ok) {
            console.log('Provider stats not available');
            return;
        }
        
        const providers = await response.json();
        const tbody = document.getElementById('providerTableBody');
        
        if (!tbody) return;
        
        if (providers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--color-text-secondary);">No provider data yet</td></tr>';
            return;
        }
        
        tbody.innerHTML = providers.map(p => {
            // Determine status badge based on success rate
            let statusBadge = '<span class="badge badge-success">Online</span>';
            if (p.success_rate < 50) statusBadge = '<span class="badge badge-error">Offline</span>';
            else if (p.success_rate < 80) statusBadge = '<span class="badge badge-warning">Degraded</span>';
            
            return `
                <tr>
                    <td>${escapeHtml(p.provider_name)}</td>
                    <td>${statusBadge}</td>
                    <td>${p.total_requests.toLocaleString()}</td>
                    <td>${p.success_rate}%</td>
                    <td>${p.avg_response_ms}ms</td>
                    <td>${p.subtitles_returned.toLocaleString()}</td>
                </tr>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Failed to load provider stats:', error);
    }
}
