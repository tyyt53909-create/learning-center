export const reviewRatings = new Set(['again', 'hard', 'good', 'easy']);

export function scheduleReview(card, rating, now = new Date()) {
  if (!reviewRatings.has(rating)) throw new Error('评分选项无效');
  const ease = Number.isFinite(card.ease_factor) ? card.ease_factor : 2.5;
  const prevInterval = Math.max(0, Number(card.interval_days) || 0);
  const prevReps = Math.max(0, Number(card.repetitions) || 0);
  const prevLapses = Math.max(0, Number(card.lapses) || 0);

  let ease_factor = ease;
  let interval_days = prevInterval;
  let repetitions = prevReps;
  let lapses = prevLapses;
  let delayMs;

  if (rating === 'again') {
    repetitions = 0;
    lapses = prevLapses + 1;
    interval_days = 0;
    ease_factor = Math.max(1.3, Number((ease - 0.2).toFixed(2)));
    delayMs = 10 * 60_000;
  } else if (rating === 'hard') {
    interval_days = prevReps === 0 ? 1 : Math.max(1, Math.round(prevInterval * 1.2));
    repetitions = prevReps + 1;
    ease_factor = Math.max(1.3, Number((ease - 0.15).toFixed(2)));
    delayMs = interval_days * 86_400_000;
  } else if (rating === 'good') {
    interval_days = prevReps === 0 ? 1 : prevReps === 1 ? 6 : Math.max(1, Math.round(prevInterval * ease));
    repetitions = prevReps + 1;
    ease_factor = Number(ease.toFixed(2));
    delayMs = interval_days * 86_400_000;
  } else {
    interval_days = prevReps === 0 ? 4 : prevReps === 1 ? 10 : Math.max(2, Math.round(prevInterval * ease * 1.3));
    repetitions = prevReps + 1;
    ease_factor = Math.min(3.5, Number((ease + 0.15).toFixed(2)));
    delayMs = interval_days * 86_400_000;
  }

  return {
    ease_factor,
    interval_days,
    repetitions,
    lapses,
    due_at: new Date(now.getTime() + delayMs),
    label: rating === 'again' ? '10 分钟' : formatIntervalDays(interval_days),
  };
}

export function formatIntervalDays(days) {
  if (days <= 0) return '10 分钟';
  if (days < 30) return `${days} 天`;
  if (days < 365) {
    const months = Math.round((days / 30) * 10) / 10;
    return `${months} 个月`;
  }
  const years = Math.round((days / 365) * 10) / 10;
  return `${years} 年`;
}

export function previewIntervals(card) {
  return Object.fromEntries(
    ['again', 'hard', 'good', 'easy'].map((rating) => [rating, scheduleReview(card, rating).label]),
  );
}
