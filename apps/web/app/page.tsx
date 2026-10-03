import { redirect } from 'next/navigation';
import { signedOwner } from '../lib/auth';
import Chat from './chat';
export const dynamic='force-dynamic';
export default async function Page() { if(!await signedOwner()) redirect('/login'); return <Chat/>; }
