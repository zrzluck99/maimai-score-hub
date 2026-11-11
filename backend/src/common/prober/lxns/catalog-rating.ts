import {
  getRating,
  normalizeAchievement,
  buildB50RatingSummary,
} from '../../rating';
import type { ChartPayload } from '../../../modules/music/schemas/music.schema';

export type RatingMusic = {
  id: string;
  type?: string;
  isNew?: boolean | null;
  disabled?: boolean;
  charts?: ChartPayload[];
};
export type RatingScore = {
  musicId: string;
  chartIndex: number;
  score?: string | number | null;
  rating?: number | null;
  isNew?: boolean | null;
  type?: string | null;
};

/** A read-only projection. Missing historical references remain in the result. */
export function projectCatalogRating<T extends RatingScore>(
  scores: readonly T[],
  music: readonly RatingMusic[],
  now = new Date(),
): T[] {
  const index = new Map(music.map((m) => [m.id, m]));
  return scores.map((score) => {
    const song = index.get(score.musicId);
    if (!song) {
      return { ...score };
    }
    const chart = song.charts?.[score.chartIndex === 10 ? 0 : score.chartIndex];
    if (!chart?.cid) {
      return { ...score, rating: null };
    }
    const released =
      !chart.releaseDate ||
      new Date(`${chart.releaseDate}T07:00:00+08:00`) <= now;
    const achievement = normalizeAchievement(score.score);
    return {
      ...score,
      isNew: song.isNew ?? null,
      rating:
        !song.disabled &&
        released &&
        song.type !== 'utage' &&
        typeof chart.detailLevel === 'number' &&
        achievement !== null
          ? getRating(chart.detailLevel, achievement)
          : null,
    };
  });
}

export function catalogB50<T extends RatingScore>(
  scores: readonly T[],
  music: readonly RatingMusic[],
  now = new Date(),
) {
  return buildB50RatingSummary(
    projectCatalogRating(scores, music, now),
    new Set(music.map((m) => m.id)),
  );
}
