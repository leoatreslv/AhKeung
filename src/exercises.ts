import type { Exercise } from './db';

export const exercises: Exercise[] = [
  // Chest
  { id: 'bench-press', name: 'Barbell Bench Press', muscleGroup: 'chest', equipment: 'Barbell', emoji: '🏋️', description: 'Lie on bench, lower bar to mid-chest, press up. Keep elbows ~45°.' },
  { id: 'incline-db-press', name: 'Incline Dumbbell Press', muscleGroup: 'chest', equipment: 'Dumbbells', emoji: '💪', description: 'Bench at 30–45°. Press dumbbells from shoulder level to lockout.' },
  { id: 'push-up', name: 'Push-Up', muscleGroup: 'chest', equipment: 'Bodyweight', emoji: '🤸', description: 'Plank position, lower chest to floor, push back up. Body straight.' },
  { id: 'chest-fly', name: 'Cable / Dumbbell Fly', muscleGroup: 'chest', equipment: 'Cable/Dumbbells', emoji: '🦋', description: 'Arms slightly bent, bring hands together in arc across chest.' },
  { id: 'dips-chest', name: 'Chest Dips', muscleGroup: 'chest', equipment: 'Dip Bars', emoji: '🧗', description: 'Lean forward, lower until shoulders below elbows, press up.' },

  // Back
  { id: 'pull-up', name: 'Pull-Up', muscleGroup: 'back', equipment: 'Pull-Up Bar', emoji: '🧗‍♂️', description: 'Hang with overhand grip, pull chin over bar, lower with control.' },
  { id: 'lat-pulldown', name: 'Lat Pulldown', muscleGroup: 'back', equipment: 'Cable Machine', emoji: '🪢', description: 'Pull bar to upper chest, squeeze shoulder blades down and back.' },
  { id: 'bent-over-row', name: 'Bent-Over Barbell Row', muscleGroup: 'back', equipment: 'Barbell', emoji: '🏋️‍♂️', description: 'Hinge at hips, row bar to lower ribs, elbows tucked.' },
  { id: 'seated-cable-row', name: 'Seated Cable Row', muscleGroup: 'back', equipment: 'Cable Machine', emoji: '🚣', description: 'Sit upright, pull handle to abdomen, squeeze back.' },
  { id: 'deadlift', name: 'Deadlift', muscleGroup: 'back', equipment: 'Barbell', emoji: '⚡', description: 'Hinge to grip bar, drive through floor, stand tall with neutral spine.' },
  { id: 'face-pull', name: 'Face Pull', muscleGroup: 'back', equipment: 'Cable Machine', emoji: '😤', description: 'Pull rope to face, elbows high, focus on rear delts and upper back.' },

  // Shoulders
  { id: 'overhead-press', name: 'Overhead Press', muscleGroup: 'shoulders', equipment: 'Barbell', emoji: '🆙', description: 'Press bar from shoulders overhead, brace core, full lockout.' },
  { id: 'db-shoulder-press', name: 'Dumbbell Shoulder Press', muscleGroup: 'shoulders', equipment: 'Dumbbells', emoji: '💪', description: 'Seated or standing, press dumbbells from shoulders to overhead.' },
  { id: 'lateral-raise', name: 'Lateral Raise', muscleGroup: 'shoulders', equipment: 'Dumbbells', emoji: '🦅', description: 'Raise dumbbells out to sides until arms parallel to floor.' },
  { id: 'rear-delt-fly', name: 'Rear Delt Fly', muscleGroup: 'shoulders', equipment: 'Dumbbells', emoji: '🪶', description: 'Bent over, raise dumbbells out to sides, squeeze rear delts.' },

  // Biceps
  { id: 'barbell-curl', name: 'Barbell Curl', muscleGroup: 'biceps', equipment: 'Barbell', emoji: '💪', description: 'Curl bar with elbows pinned to sides, full range of motion.' },
  { id: 'hammer-curl', name: 'Hammer Curl', muscleGroup: 'biceps', equipment: 'Dumbbells', emoji: '🔨', description: 'Neutral grip, curl dumbbells up keeping thumbs facing ceiling.' },
  { id: 'preacher-curl', name: 'Preacher Curl', muscleGroup: 'biceps', equipment: 'Preacher Bench', emoji: '🛐', description: 'Arms on pad, curl with strict form, no swinging.' },

  // Triceps
  { id: 'tricep-pushdown', name: 'Tricep Pushdown', muscleGroup: 'triceps', equipment: 'Cable Machine', emoji: '⬇️', description: 'Elbows tucked, push handle down until arms fully extended.' },
  { id: 'skull-crusher', name: 'Skull Crusher', muscleGroup: 'triceps', equipment: 'EZ-Bar', emoji: '💀', description: 'Lie on bench, lower bar to forehead, extend back up.' },
  { id: 'tricep-dip', name: 'Tricep Dip', muscleGroup: 'triceps', equipment: 'Dip Bars', emoji: '⬇️', description: 'Upright torso, lower body, press up with triceps.' },

  // Legs
  { id: 'back-squat', name: 'Back Squat', muscleGroup: 'legs', equipment: 'Barbell', emoji: '🏋️', description: 'Bar on traps, descend until thighs parallel, drive up through heels.' },
  { id: 'front-squat', name: 'Front Squat', muscleGroup: 'legs', equipment: 'Barbell', emoji: '🏋️‍♀️', description: 'Bar on front delts, upright torso, deep squat.' },
  { id: 'leg-press', name: 'Leg Press', muscleGroup: 'legs', equipment: 'Leg Press Machine', emoji: '🦵', description: 'Feet shoulder-width on platform, lower under control, press up.' },
  { id: 'lunge', name: 'Walking Lunge', muscleGroup: 'legs', equipment: 'Dumbbells', emoji: '🚶', description: 'Step forward, knee to floor, drive up and switch legs.' },
  { id: 'leg-curl', name: 'Leg Curl', muscleGroup: 'legs', equipment: 'Leg Curl Machine', emoji: '🦵', description: 'Curl heels toward glutes, squeeze hamstrings.' },
  { id: 'calf-raise', name: 'Calf Raise', muscleGroup: 'legs', equipment: 'Machine/Bodyweight', emoji: '🦶', description: 'Raise heels as high as possible, slow lower.' },

  // Glutes
  { id: 'hip-thrust', name: 'Hip Thrust', muscleGroup: 'glutes', equipment: 'Barbell + Bench', emoji: '🍑', description: 'Upper back on bench, bar on hips, thrust up, squeeze glutes at top.' },
  { id: 'glute-bridge', name: 'Glute Bridge', muscleGroup: 'glutes', equipment: 'Bodyweight', emoji: '🌉', description: 'Lie on back, drive hips up, squeeze glutes.' },
  { id: 'romanian-deadlift', name: 'Romanian Deadlift', muscleGroup: 'glutes', equipment: 'Barbell', emoji: '⚡', description: 'Hinge at hips, slight knee bend, bar down legs, drive hips forward.' },

  // Core
  { id: 'plank', name: 'Plank', muscleGroup: 'core', equipment: 'Bodyweight', emoji: '🧘', description: 'Forearms and toes, body straight, brace core. Hold for time.' },
  { id: 'hanging-leg-raise', name: 'Hanging Leg Raise', muscleGroup: 'core', equipment: 'Pull-Up Bar', emoji: '🙆', description: 'Hang from bar, raise legs to 90° or higher, controlled descent.' },
  { id: 'cable-crunch', name: 'Cable Crunch', muscleGroup: 'core', equipment: 'Cable Machine', emoji: '🙇', description: 'Kneel, rope behind head, crunch down using abs.' },
  { id: 'russian-twist', name: 'Russian Twist', muscleGroup: 'core', equipment: 'Plate/Bodyweight', emoji: '🌀', description: 'Lean back, feet up, rotate side to side touching ground.' },

  // Cardio
  { id: 'treadmill', name: 'Treadmill', muscleGroup: 'cardio', equipment: 'Treadmill', emoji: '🏃', description: 'Steady-state or intervals. Track time/distance instead of reps.' },
  { id: 'rowing', name: 'Rowing Machine', muscleGroup: 'cardio', equipment: 'Rower', emoji: '🚣', description: 'Drive legs first, lean back, pull handle to chest. Full body cardio.' },
  { id: 'bike', name: 'Stationary Bike', muscleGroup: 'cardio', equipment: 'Bike', emoji: '🚴', description: 'Adjust resistance, maintain cadence. Track time/distance.' },
];

export const exerciseById = (id: string) => exercises.find((e) => e.id === id);
