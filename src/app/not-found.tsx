import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card"><div className="empty">
      <p><strong>Not found.</strong> The incident, case or page does not exist.</p>
      <Link href="/">Back to overview</Link>
    </div></div>
  );
}
