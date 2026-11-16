import type {
  DimensionJudgement,
  FluencyChange,
  FluencyDimension,
  LearnerReadingQuestion,
  LearningTaskView,
  RetrieveOption,
  TaskSubmission,
} from '@/lib/domain/model';

/** 今日计划响应（/api/plan/today）。 */
export interface TodayPlanResponse {
  date: string;
  plan: { id: string; taskCapacity: number } | null;
  tasks: Array<LearningTaskView & { sources?: Array<{id:string;title:string}> }>;
}

export interface PlanFailureResponse {
  reason: string;
  date: string;
}

/** 作答提交响应（/api/tasks/:id/attempt）。 */
export interface AttemptResponse {
  attemptId: string;
  status: string;
  statusReason?: string | null;
  feedback: string | null;
  judgement: {
    judgedBy: string;
    dimensions: Partial<Record<FluencyDimension, DimensionJudgement>>;
  } | null;
  settlement: { settledAt: string; fluencyChanges: FluencyChange[] } | null;
  refresh: { plan?: { id: string; taskCapacity: number } | null; tasks?: Array<LearningTaskView & {sources?:Array<{id:string;title:string}>}>; reason?: string };
}

/** 学习者档案响应（/api/learner）。 */
export interface LearnerResponse {
  learner: {
    id: string;
    timezone: string;
    dailyTaskCapacity: number;
    currentVocabulary: {
      list: { id: string; version: string };
      bands: Array<{
        band: string;
        wordFamilyCount: number;
        knownProbability: number;
        sampleCount: number;
        knownCount: number;
        interval: { lower: number; upper: number; level: number } | null;
      }>;
      estimatedAt: string;
    } | null;
  };
  llmConfigured: boolean;
  counts: { materials: number; goals: number; tasks: number; attempts: number };
}

export interface MaterialListItem {
  id: string;
  title: string;
  filename: string;
  format: string;
  createdAt: string;
  archivedAt?: string | null;
  analysis: { id: string; status: 'pending' | 'analyzed' | 'failed'; itemCount: number; unmatchedCount: number; frequencyRank: number; frequentTermCount: number; createdAt: string } | null;
}

export interface MaterialsResponse {
  materials: MaterialListItem[];
}

export interface ImportResultResponse {
  material: { id: string; title: string; filename: string; format: string };
  analysis: {
    id: string;
    itemCount: number;
    unmatchedCount: number;
    items: Array<{
      knowledgePointId: string;
      lemma: string;
      definition: string;
      partOfSpeech: string | null;
      occurrenceCount: number;
    }>;
    unmatched: Array<{ lemma: string | null; reason: string; occurrenceCount: number }>;
  };
}

export interface GoalListItem {
  id: string;
  title: string;
  status: string;
  targetFluency: { R: number; P: number };
  candidateCount: number;
  includedCount: number;
  materialCount: number;
}

export interface GoalsResponse {
  goals: GoalListItem[];
}

export interface GoalDetailResponse {
  goal: { id: string; title: string; status: string; targetFluency: { R: number; P: number } };
  assessmentCompleted: boolean;
  materials: Array<{ materialId: string; title: string; analysisId: string | null }>;
  progress: { selectedCount: number; completedCount: number; inProgressCount: number; uninitializedCount: number; completionRate: number | null; averageFluency: { R: number; P: number } | null };
  candidates: Array<{
    knowledgePointId: string;
    name: string;
    definition: string | null;
    partOfSpeech: string | null;
    selection: 'undecided' | 'included' | 'excluded';
    band: string | null;
    learning: {
      fluency: { R: number; P: number };
      dueAt: { R: string; P: string };
      graduated: { R: boolean; P: boolean };
    } | null;
  }>;
}

export interface AssessmentTask {
  id: string;
  band: string;
  knowledgePointId: string;
  lemma: string;
}

export interface StartAssessmentResponse {
  assessmentId: string;
  tasks: AssessmentTask[];
  cursor: number;
  answered: number;
  total: number;
  currentBand: string | null;
  bandAnswered: number;
  bandTotal: number;
}

export interface SubmitAssessmentResponse {
  status: 'in_progress' | 'completed';
  answered?: number;
  total?: number;
  assessmentId?: string;
  tasks?: AssessmentTask[];
  cursor?: number;
  currentBand?: string | null;
  bandAnswered?: number;
  bandTotal?: number;
  early?: boolean;
  result?: LearnerResponse['learner']['currentVocabulary'];
}

export type { DimensionJudgement, FluencyChange, FluencyDimension, LearnerReadingQuestion, LearningTaskView, RetrieveOption, TaskSubmission };
