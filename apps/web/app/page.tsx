import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { signedOwner } from '../lib/auth';
import Chat from './chat';
export const dynamic='force-dynamic';
export default async function Page() { const owner=await signedOwner();if(!owner) redirect('/login');return <Chat ownerScope={createHash('sha256').update(owner).digest('hex')}/>; }
