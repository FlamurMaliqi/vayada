import Image from "next/image";
import Link from "next/link";
import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { ROUTES } from "@/lib/constants/routes";

export default function Hero() {
  return (
    <section className="relative overflow-hidden pb-14 pt-24 md:pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[var(--gradient-hero)]" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-12">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-primary-600">For hotels and travel creators</p>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-5xl">
              <span className="block">Hotels grow direct.</span>
              <span className="block">Creators find great stays.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-600">
              Booking Engine, PMS and Creator Marketplace connect operations, direct demand and
              trusted travel creators.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/#products"
                className="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-primary-500 px-6 text-sm font-medium text-white shadow-glow transition-colors hover:bg-primary-600 active:translate-y-px"
              >
                Explore hotel products
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
              <a
                href={ROUTES.PROPERTIES}
                className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full border border-border-strong bg-white px-6 text-sm font-medium text-ink transition-colors hover:bg-surface-elevated active:translate-y-px"
              >
                Browse hotel stays
              </a>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-8 rounded-3xl bg-primary-500/10 blur-3xl" />
            <div className="relative overflow-hidden rounded-3xl border border-border-strong bg-white shadow-elevated">
              <Image
                src="/hero-booking.png"
                alt="Vayada direct booking page for Green Poya Resort"
                width={1920}
                height={966}
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="h-auto w-full object-contain"
                priority
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
