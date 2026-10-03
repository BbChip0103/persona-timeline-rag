import type { Metadata } from 'next';
import './styles.css';
export const metadata:Metadata={title:'Persona Lab · Private research',description:'Private, unofficial AI persona research interface'};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="ko"><body>{children}</body></html>;}
