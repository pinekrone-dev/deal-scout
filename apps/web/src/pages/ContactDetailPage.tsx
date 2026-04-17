import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, onSnapshot, Timestamp, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { Contact, ContactRole } from '../types';

const ROLES: ContactRole[] = ['broker', 'sponsor', 'owner', 'lender', 'tenant', 'other'];

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [contact, setContact] = useState<Contact | null>(null);

  useEffect(() => {
    if (!id) return;
    const unsub = onSnapshot(doc(db, 'contacts', id), (snap) => {
      if (snap.exists()) setContact({ id: snap.id, ...(snap.data() as Contact) });
    });
    return () => unsub();
  }, [id]);

  async function patch(p: Partial<Contact>) {
    if (!id) return;
    await updateDoc(doc(db, 'contacts', id), { ...p, updated_at: Timestamp.fromMillis(Date.now()) });
  }

  if (!contact) return <div className="text-sm text-ink-500">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="text-xs uppercase tracking-wide text-ink-500">
        <Link to="/contacts" className="hover:underline">Contacts</Link> / {contact.name}
      </div>
      <div className="card p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="label">Name</div>
          <input className="field" value={contact.name ?? ''} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div>
          <div className="label">Role</div>
          <select
            className="field"
            value={contact.role}
            onChange={(e) => patch({ role: e.target.value as ContactRole })}
          >
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <div className="label">Firm</div>
          <input className="field" value={contact.firm ?? ''} onChange={(e) => patch({ firm: e.target.value })} />
        </div>
        <div>
          <div className="label">Email</div>
          <input className="field" value={contact.email ?? ''} onChange={(e) => patch({ email: e.target.value })} />
        </div>
        <div>
          <div className="label">Phone</div>
          <input className="field" value={contact.phone ?? ''} onChange={(e) => patch({ phone: e.target.value })} />
        </div>
        <div>
          <div className="label">LinkedIn</div>
          <input className="field" value={contact.linkedin ?? ''} onChange={(e) => patch({ linkedin: e.target.value })} />
        </div>
        <div className="md:col-span-2">
          <div className="label">Notes</div>
          <textarea
            className="field min-h-[120px]"
            value={contact.notes ?? ''}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
