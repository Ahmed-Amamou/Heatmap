const heatmapEl = document.getElementById('heatmap');
const monthLabelsEl = document.getElementById('month-labels');
const tooltipEl = document.getElementById('tooltip');
const statsEl = document.getElementById('stats');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');

const WEEKS_TO_SHOW = 18;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getLevel(count) {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function dateToKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function calculateStreak(dateCounts) {
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkDate = new Date(today);

  if (!dateCounts[dateToKey(checkDate)]) {
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (dateCounts[dateToKey(checkDate)]) {
    streak++;
    checkDate.setDate(checkDate.getDate() - 1);
  }

  return streak;
}

function renderHeatmap(dateCounts) {
  heatmapEl.innerHTML = '';
  monthLabelsEl.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (WEEKS_TO_SHOW * 7) + (7 - today.getDay()));

  const totalApps = Object.values(dateCounts).reduce((sum, c) => sum + c, 0);
  const streak = calculateStreak(dateCounts);

  statsEl.textContent = `${totalApps} sent · ${streak}d streak`;

  let lastMonth = -1;
  const cellWidth = 16;
  let cellIndex = 0;

  for (let week = 0; week < WEEKS_TO_SHOW; week++) {
    const weekEl = document.createElement('div');
    weekEl.className = 'week';

    for (let day = 0; day < 7; day++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + (week * 7) + day);

      const dayEl = document.createElement('div');
      dayEl.className = 'day';

      if (currentDate > today) {
        dayEl.classList.add('empty');
        weekEl.appendChild(dayEl);
        continue;
      }

      const key = dateToKey(currentDate);
      const count = dateCounts[key] || 0;
      const level = getLevel(count);

      dayEl.setAttribute('data-level', level);
      dayEl.setAttribute('data-date', key);
      dayEl.setAttribute('data-count', count);

      // Staggered entrance animation
      dayEl.classList.add('animate-in');
      dayEl.style.animationDelay = `${cellIndex * 3}ms`;
      cellIndex++;

      // Tooltip events
      const dateCopy = new Date(currentDate);
      dayEl.addEventListener('mouseenter', (e) => showTooltip(e, dateCopy, count));
      dayEl.addEventListener('mouseleave', hideTooltip);

      weekEl.appendChild(dayEl);

      if (day === 0) {
        const month = currentDate.getMonth();
        if (month !== lastMonth) {
          lastMonth = month;
          const label = document.createElement('span');
          label.className = 'month-label';
          label.textContent = MONTH_NAMES[month];
          label.style.left = `${week * cellWidth}px`;
          monthLabelsEl.appendChild(label);
        }
      }
    }

    heatmapEl.appendChild(weekEl);
  }
}

function showTooltip(event, date, count) {
  const appText = count === 1 ? '1 application' : `${count} applications`;
  tooltipEl.innerHTML = `<span class="count">${appText}</span> <span class="date">on ${formatDate(date)}</span>`;
  tooltipEl.classList.remove('hidden');

  const rect = event.target.getBoundingClientRect();
  const widgetRect = document.getElementById('widget').getBoundingClientRect();

  tooltipEl.style.left = `${rect.left - widgetRect.left + rect.width / 2 - tooltipEl.offsetWidth / 2}px`;
  tooltipEl.style.top = `${rect.top - widgetRect.top - tooltipEl.offsetHeight - 8}px`;
}

function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

async function loadData() {
  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn.classList.add('spinning');
  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');

  try {
    const data = await window.heatmapAPI.fetchData();

    if (data.error) {
      throw new Error(data.error);
    }

    loadingEl.classList.add('hidden');
    renderHeatmap(data);
  } catch (err) {
    loadingEl.classList.add('hidden');
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    renderHeatmap({});
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// Button handlers
document.getElementById('btn-close').addEventListener('click', () => {
  window.heatmapAPI.closeApp();
});

document.getElementById('btn-minimize').addEventListener('click', () => {
  window.heatmapAPI.minimizeToTray();
});

document.getElementById('btn-refresh').addEventListener('click', loadData);

document.getElementById('btn-settings').addEventListener('click', () => {
  window.heatmapAPI.openSettings();
});

document.getElementById('btn-pin').addEventListener('click', async () => {
  const pinned = await window.heatmapAPI.toggleAlwaysOnTop();
  document.getElementById('btn-pin').classList.toggle('active', pinned);
});

// Listen for auto-refresh
window.heatmapAPI.onDataRefreshed((data) => {
  if (!data.error) {
    renderHeatmap(data);
  }
});

// Initial load
loadData();
