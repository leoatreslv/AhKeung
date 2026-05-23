import type { MuscleGroup } from '../db';

export type Locale = 'en' | 'zh-Hant';

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-Hant', label: '繁體中文' },
];

export interface Translation {
  appName: string;
  tagline: string;

  tabs: { home: string; plans: string; library: string; metrics: string };

  muscleGroup: Record<MuscleGroup, string>;

  common: {
    save: string;
    cancel: string;
    delete: string;
    edit: string;
    add: string;
    done: string;
    search: string;
    loading: string;
    all: string;
    yes: string;
    no: string;
    notes: string;
    date: string;
  };

  home: {
    thisWeek: string;
    noPlanThisWeek: string;
    createPlan: string;
    startWorkout: string;
    quickActions: string;
    freeWorkout: string;
    logWeight: string;
    latestMetric: string;
    weight: string;
    height: string;
    recentSessions: string;
    exercisesPlanned: (n: number) => string;
    sessionSummary: (exCount: number, setsDone: number) => string;
    noWorkouts: string;
    assignedByTrainer: string;
  };

  plans: {
    title: string;
    newButton: string;
    weekOf: string;
    exerciseCount: (n: number) => string;
    noPlans: string;
    createFirst: string;
    start: string;
  };

  planEditor: {
    namePlaceholder: string;
    nameLabel: string;
    namePlaceholderExample: string;
    weekStarting: string;
    focusGroups: string;
    exercises: string;
    addExercise: string;
    noExercises: string;
    sets: string;
    reps: string;
    weightKg: string;
    savePlan: string;
    deleteConfirm: string;
    nameRequired: string;
    pickExercise: string;
    noMatch: string;
  };

  workout: {
    elapsed: string;
    progress: string;
    noExercises: string;
    set: string;
    weightUnit: string;
    addSet: string;
    addExercise: string;
    finish: string;
    discardConfirm: string;
    noSetsDoneConfirm: string;
    addExerciseTitle: string;
  };

  library: {
    searchPlaceholder: string;
    noMatch: string;
    instructions: string;
    level: string;
    primaryMuscles: string;
    secondaryMuscles: string;
    viewDetails: string;
    favorites: string;
    others: string;
    addToFavorites: string;
    removeFromFavorites: string;
  };

  metrics: {
    logEntry: string;
    weightKg: string;
    heightCm: string;
    bodyFatPct: string;
    enterValue: string;
    bmi: string;
    weightTrend: string;
    history: string;
    noEntries: string;
    deleteConfirm: string;
  };

  exerciseEditor: {
    title: string;
    titleEditing: string;
    nameEn: string;
    nameZh: string;
    namePlaceholder: string;
    muscleGroup: string;
    equipment: string;
    equipmentPlaceholder: string;
    instructions: string;
    instructionsPlaceholder: string;
    image: string;
    imagePickCamera: string;
    imagePickLibrary: string;
    imageUploading: string;
    save: string;
    delete: string;
    deleteConfirm: string;
    needsName: string;
    needsMuscleGroup: string;
  };

  myExercises: {
    title: string;
    newButton: string;
    empty: string;
    notATrainerYet: string;
  };

  bundleEditor: {
    title: string;
    titleEditing: string;
    name: string;
    namePlaceholder: string;
    description: string;
    descriptionPlaceholder: string;
    exercises: string;
    noExercises: string;
    addExercise: string;
    save: string;
    delete: string;
    deleteConfirm: string;
    needsName: string;
  };

  myBundles: {
    title: string;
    newButton: string;
    empty: string;
    exerciseCount: (n: number) => string;
  };

  myTrainees: {
    title: string;
    addByName: string;
    searchPlaceholder: string;
    searching: string;
    noResults: string;
    designate: string;
    remove: string;
    removeConfirm: string;
    accepted: string;
    pending: string;
    declined: string;
    empty: string;
    promote: string;
    promoted: string;
    promoteConfirm: string;

    inviteByEmail: string;
    inviteEmailPlaceholder: string;
    inviteSend: string;
    inviteSending: string;
    inviteSent: string;
    inviteAlreadyExisted: string;
    inviteRateLimited: string;
    inviteFailed: string;

    pendingInvites: string;
    inviteStatusPending: string;
    inviteStatusAccepted: string;
    inviteStatusAlreadyExisted: string;
    inviteStatusCancelled: string;
    inviteStatusExpired: string;
    inviteCancel: string;
    inviteCancelConfirm: string;
    inviteResend: string;
  };

  share: {
    button: string;
    shareTitle: string;
    shareWithCount: (n: number) => string;
    sharing: string;
    noAcceptedTrainees: string;
    sharePlan: string;
    sharePlanTitle: string;
    sharePlanSuccess: (n: number) => string;
    sharePlanFailed: string;
  };

  designation: {
    pendingTitle: string;
    wantsToTrain: string;
    accept: string;
    decline: string;
    yourTrainers: string;
    block: string;
    blockConfirm: string;
  };

  login: {
    byInvitationOnly: string;
    emailLabel: string;
    passwordLabel: string;
    signIn: string;
    sendReset: string;
    sending: string;
    forgotPassword: string;
    backToSignIn: string;
    resetSent: string;
    resetInstructions: string;
    noAccountYet: string;
    invalidPassword: string;
    rateLimited: string;
    linkFailed: string;
  };

  onboarding: {
    title: string;
    welcome: string;
    displayNameLabel: string;
    displayNamePlaceholder: string;
    passwordLabel: string;
    passwordConfirm: string;
    passwordMismatch: string;
    passwordTooShort: string;
    submit: string;
    submitting: string;
    passwordSaveFailed: string;
    profileSaveFailed: string;
  };

  resetPassword: {
    title: string;
    subtitle: string;
    passwordLabel: string;
    confirmLabel: string;
    submit: string;
    submitting: string;
    failed: string;
  };

  settings: {
    changePassword: string;
    newPassword: string;
    confirmPassword: string;
    saveButton: string;
    saving: string;
    passwordSaved: string;
    passwordSaveFailed: string;
  };

  diagnostics: {
    title: string;
    viewLink: string;
    hide: string;
    summary: (showing: number, totalBuffered: number) => string;
    empty: string;
    notesLabel: string;
    notesPlaceholder: string;
    copy: string;
    send: string;
    sending: string;
    clear: string;
    clearConfirm: string;
    sentSuccess: string;
    sentHelp: string;
    sendFailed: string;
  };
}
