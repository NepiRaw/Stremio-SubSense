/**
 * SubSense Statistics Dashboard Logic
 */

let sourceChart = null;
let langChart = null;
let timingChart = null;
let refreshInterval = null;

const REFRESH_INTERVAL_MS = 30000; // 30 seconds

// Chart colors
const CHART_COLORS = [
    '#7b2cbf', '#9d4edd', '#c77dff', '#e0aaff',
    '#3498db', '#2ecc71', '#f39c12', '#e74c3c',
    '#9b59b6', '#1abc9c', '#34495e', '#95a5a6'
];

/**
 * Initialize the dashboard
 */
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    loadStats();
    setupAutoRefresh();
});

/**
 * Initialize empty charts
 */
function initCharts() {
    // Source distribution (pie)
    const sourceCtx = document.getElementById('sourceChart').getContext('2d');
    sourceChart = new Chart(sourceCtx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: CHART_COLORS
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#eee' }
                }
            }
        }
    });

    // Language distribution (pie)
    const langCtx = document.getElementById('langChart').getContext('2d');
    langChart = new Chart(langCtx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: CHART_COLORS
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#eee' }
                }
            }
        }
    });

    // Timing chart (line)
    const timingCtx = document.getElementById('timingChart').getContext('2d');
    timingChart = new Chart(timingCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Fetch Time (ms)',
                data: [],
                borderColor: '#7b2cbf',
                backgroundColor: 'rgba(123, 44, 191, 0.2)',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#aaa' },
                    grid: { color: '#333' }
                },
                x: {
                    ticks: { color: '#aaa' },
                    grid: { color: '#333' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#eee' }
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
        const response = await fetch('/stats/json');
        const stats = await response.json();
        
        updateOverview(stats);
        updateLanguageMatching(stats);
        updateCharts(stats);
        updateDailyTable(stats);
        updateErrorsTable(stats);
        updateLastUpdated();
        
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
    document.getElementById('secondarySuccessRate').textContent = `${lm.secondarySuccessRate || 0}%`;
    document.getElementById('primaryFound').textContent = (lm.primaryFound || 0).toLocaleString();
    document.getElementById('primaryNotFound').textContent = (lm.primaryNotFound || 0).toLocaleString();
    
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
    // Source chart
    const sourceLabels = Object.keys(stats.subtitles.bySource);
    const sourceData = Object.values(stats.subtitles.bySource);
    sourceChart.data.labels = sourceLabels.length > 0 ? sourceLabels : ['No data'];
    sourceChart.data.datasets[0].data = sourceData.length > 0 ? sourceData : [1];
    sourceChart.update();

    // Language chart
    const langLabels = Object.keys(stats.subtitles.byLanguage);
    const langData = Object.values(stats.subtitles.byLanguage);
    langChart.data.labels = langLabels.length > 0 ? langLabels : ['No data'];
    langChart.data.datasets[0].data = langData.length > 0 ? langData : [1];
    langChart.update();

    // Timing chart
    const timingHistory = stats.timing.recentHistory || [];
    timingChart.data.labels = timingHistory.map((_, i) => `#${i + 1}`);
    timingChart.data.datasets[0].data = timingHistory;
    timingChart.update();
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

    if (dateStr === today.toISOString().split('T')[0]) return 'Today';
    if (dateStr === yesterday.toISOString().split('T')[0]) return 'Yesterday';
    
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
