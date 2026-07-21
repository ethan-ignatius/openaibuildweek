import { ArrowLeft, LockKeyhole } from "lucide-react";
import { Logo } from "../../../components/shared/Logo";

export default function StudentStationPage() {
  return <main className="student-station"><header><Logo /><span><LockKeyhole />Private student station · feature preview</span></header><section><span className="hero-kicker">Assigned practice</span><h1>Decimal comparison</h1><p>This private route is ready for teacher-assigned Visual Bridges. It never exposes other students’ information.</p><div className="student-placeholder"><span>0.35</span><b>?</b><span>0.40</span></div><a href="/teacher"><ArrowLeft />Return to teacher</a></section></main>;
}
