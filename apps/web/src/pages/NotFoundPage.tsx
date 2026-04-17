import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="min-h-screen grid place-items-center">
      <div className="text-center">
        <div className="text-sm uppercase tracking-wide text-ink-500">404</div>
        <div className="text-xl font-semibold mt-1">Page not found</div>
        <Link className="btn mt-4 inline-flex" to="/buildings">Back to buildings</Link>
      </div>
    </div>
  );
}
