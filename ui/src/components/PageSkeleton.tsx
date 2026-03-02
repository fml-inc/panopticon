export function PageSkeleton() {
  return (
    <div className="p-8 space-y-6 animate-pulse">
      <div className="h-8 w-48 bg-slate-800 rounded" />
      <div className="h-4 w-64 bg-slate-800/50 rounded" />
      <div className="grid gap-4 mt-8">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 bg-slate-900/50 border border-slate-800 rounded-xl"
          />
        ))}
      </div>
    </div>
  );
}
