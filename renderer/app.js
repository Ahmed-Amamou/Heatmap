const heatmapEl = document.getElementById('heatmap');
const monthLabelsEl = document.getElementById('month-labels');
const tooltipEl = document.getElementById('tooltip');
const statsEl = document.getElementById('stats');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');

const LEVELS = [0, 1, 2, 3, 4];
const WEEKS_TO_SHOW = 18; // ~4 months
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

  // If no applications today, start checking from yesterday
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

  // Find the start date (go back WEEKS_TO_SHOW weeks, aligned to Sunday)
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (WEEKS_TO_SHOW * 7) + (7 - today.getDay()));

  const totalApps = Object.values(dateCounts).reduce((sum, c) => sum + c, 0);
  const streak = calculateStreak(dateCounts);

  statsEl.textContent = `${totalApps} applications · ${streak} day streak 🔥`;

  let lastMonth = -1;
  const cellWidth = 16; // 13px cell + 3px gap

  for (let week = 0; week < WEEKS_TO_SHOW; week++) {
    const weekEl = document.createElement('div');
    weekEl.className = 'week';

    for (let day = 0; day < 7; day++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + (week * 7) + day);

      const dayEl = document.createElement('div');
      dayEl.className = 'day';

      // Mark future days as empty
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

      // Tooltip events
      dayEl.addEventListener('mouseenter', (e) => showTooltip(e, currentDate, count));
      dayEl.addEventListener('mouseleave', hideTooltip);

      weekEl.appendChild(dayEl);

      // Month labels — show when month changes (check first day of each week)
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
  tooltipEl.style.top = `${rect.top - widgetRect.top - tooltipEl.offsetHeight - 6}px`;
}

function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

async function loadData() {
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
    errorEl.textContent = `Error: ${err.message}`;
    errorEl.classList.remove('hidden');

    // Still render an empty heatmap
    renderHeatmap({});
  }
}

// Button handlers
document.getElementById('btn-close').addEventListener('click', () => {
  window.heatmapAPI.closeApp();
});

document.getElementById('btn-refresh').addEventListener('click', loadData);

document.getElementById('btn-pin').addEventListener('click', async () => {
  const pinned = await window.heatmapAPI.toggleAlwaysOnTop();
  document.getElementById('btn-pin').style.opacity = pinned ? '1' : '0.5';
});

// Listen for auto-refresh from main process
window.heatmapAPI.onDataRefreshed((data) => {
  if (!data.error) {
    renderHeatmap(data);
  }
});

// Initial load
loadData();
