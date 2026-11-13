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
  tasks: LearningTaskView[];
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
  refresh: { plan?: { id: string; taskCapacity: number } | null; tasks?: LearningTaskView[]; reason?: string };
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
  analysis: { id: string; status: string; itemCount: number; unmatchedCount: number } | null;
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
}

export interface SubmitAssessmentResponse {
  status: 'in_progress' | 'completed';
  answered?: number;
  total?: number;
  result?: LearnerResponse['learner']['currentVocabulary'];
}

export type { DimensionJudgement, FluencyChange, FluencyDimension, LearnerReadingQuestion, LearningTaskView, RetrieveOption, TaskSubmission };
