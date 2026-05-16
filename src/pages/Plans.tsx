import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor, muscleGroupLabel } from '../db';
import { formatDate } from '../utils';

export function Plans() {
  const plans = useLiveQuery(
    () => db.plans.orderBy('createdAt').reverse().toArray(),
    [],
  );

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">My Plans</h2>
        <Link to="/plans/new" className="bg-keung-600 hover:bg-keung-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold">
          + New
        </Link>
      </div>
      {plans && plans.length > 0 ? (
        <ul className="space-y-2">
          {plans.map((p) => (
            <li key={p.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <Link to={`/plans/${p.id}`} className="block p-3">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-semibold">{p.name}</h3>
                  <span className="text-xs text-slate-400">Week of {formatDate(p.weekStart)}</span>
                </div>
                <div className="flex flex-wrap gap-1 mb-2">
                  {p.focus.map((m) => (
                    <span key={m} className={`${muscleGroupColor[m]} text-white text-[10px] px-1.5 py-0.5 rounded`}>
                      {muscleGroupLabel[m]}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-slate-400">{p.exercises.length} exercises</p>
              </Link>
              <div className="flex border-t border-slate-700">
                <Link
                  to={`/workout/${p.id}`}
                  className="flex-1 py-2 text-center text-sm text-keung-500 hover:bg-slate-700"
                >
                  ▶ Start
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-center py-12">
          <div className="text-5xl mb-2">📋</div>
          <p className="text-slate-400 mb-4">No plans yet.</p>
          <Link to="/plans/new" className="inline-block bg-keung-600 hover:bg-keung-700 text-white px-4 py-2 rounded-lg font-semibold">
            Create your first plan
          </Link>
        </div>
      )}
    </div>
  );
}
