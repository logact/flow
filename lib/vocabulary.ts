import { logger as appLogger } from './logger';
import { selectTask, type TaskType } from './scoring';

export type EstimateBand = 'common' | 'known' | 'less_common' | 'unknown';
export interface RankSource {
  id: string;
  basis: string;
}

export interface VocabularyEstimate {
  size: number;
  rankSource: RankSource;
}

export interface WordFrequencyRank {
  value: number | null;
  source: RankSource | null;
}

export interface InitialScoreEstimateInput {
  vocabulary: VocabularyEstimate;
  wordRank: WordFrequencyRank;
}

export type EstimateFailureReason =
  | 'rank_unavailable'
  | 'rank_source_missing'
  | 'rank_source_mismatch'
  | 'invalid_vocabulary_size'
  | 'invalid_rank';

export interface InitialScoreEstimate {
  R: number;
  P: number;
  band: EstimateBand;
  comparable: boolean;
  reason?: EstimateFailureReason;
}

/** Pure estimate from a comparable vocabulary-size and frequency-rank scale. */
export function estimateInitialScores(input: InitialScoreEstimateInput): InitialScoreEstimate {
  const { vocabulary, wordRank } = input;
  if (!Number.isFinite(vocabulary.size) || vocabulary.size <= 0) {
    return unknownEstimate('invalid_vocabulary_size');
  }
  if (wordRank.value === null) return unknownEstimate('rank_unavailable');
  if (!Number.isFinite(wordRank.value) || wordRank.value <= 0) {
    return unknownEstimate('invalid_rank');
  }
  if (!wordRank.source) return unknownEstimate('rank_source_missing');
  if (!sameRankSource(vocabulary.rankSource, wordRank.source)) {
    return unknownEstimate('rank_source_mismatch');
  }

  const rank = wordRank.value;
  const size = vocabulary.size;
  if (rank <= 0.5 * size) return { R: 60, P: 40, band: 'common', comparable: true };
  if (rank <= size) return { R: 40, P: 20, band: 'known', comparable: true };
  if (rank <= 1.5 * size) return { R: 20, P: 5, band: 'less_common', comparable: true };
  return { R: 0, P: 0, band: 'unknown', comparable: true };
}

function sameRankSource(a: RankSource, b: RankSource): boolean {
  return a.id === b.id && a.basis === b.basis;
}

function unknownEstimate(reason: EstimateFailureReason): InitialScoreEstimate {
  return { R: 0, P: 0, band: 'unknown', comparable: false, reason };
}

export interface VocabularyEstimateEvent {
  event: 'vocabulary.estimated';
  vocabularySize: number;
  vocabularyRankSource: RankSource;
  wordRank: number | null;
  wordRankSource: RankSource | null;
  comparable: boolean;
  reason?: EstimateFailureReason;
  band: EstimateBand;
  initialScores: { R: number; P: number };
  firstTasks: { R: ReturnType<typeof selectTask>; P: ReturnType<typeof selectTask> };
}

export type VocabularyEstimateLogger = (event: VocabularyEstimateEvent) => void;
const defaultVocabularyEstimateLogger: VocabularyEstimateLogger = event =>
  appLogger.info(event, 'Vocabulary score estimated');

/** Call at the new-word creation boundary after applying the estimate. */
export function recordVocabularyEstimate(
  input: InitialScoreEstimateInput,
  estimate: InitialScoreEstimate,
  logger: VocabularyEstimateLogger = defaultVocabularyEstimateLogger,
): VocabularyEstimateEvent {
  const event: VocabularyEstimateEvent = {
    event: 'vocabulary.estimated',
    vocabularySize: input.vocabulary.size,
    vocabularyRankSource: { ...input.vocabulary.rankSource },
    wordRank: input.wordRank.value,
    wordRankSource: input.wordRank.source ? { ...input.wordRank.source } : null,
    comparable: estimate.comparable,
    ...(estimate.reason ? { reason: estimate.reason } : {}),
    band: estimate.band,
    initialScores: { R: estimate.R, P: estimate.P },
    firstTasks: { R: selectTask(estimate.R), P: selectTask(estimate.P) },
  };
  logger(event);
  return event;
}
