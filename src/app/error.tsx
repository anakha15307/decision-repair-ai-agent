"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="alert err" role="alert">
      <p><strong>Something went wrong loading this page.</strong> {error.message}</p>
      <p className="hint">No changes were made. If the database is missing, run <code>npm run setup</code>.</p>
      <button className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
