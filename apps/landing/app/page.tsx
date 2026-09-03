import { Navigation } from "@/components/layout";
import { Hero, PlatformSection, LandingFooter } from "@/components/landing";

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-ink">
      <Navigation />
      <Hero />
      <PlatformSection />
      <LandingFooter />
    </main>
  );
}
