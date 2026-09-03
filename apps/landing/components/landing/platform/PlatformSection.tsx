import Image from "next/image";
import { ArrowRightIcon } from "@heroicons/react/24/outline";

const linkClasses =
  "mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700";

export default function PlatformSection() {
  return (
    <section id="products" className="bg-white py-16 md:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h2 className="text-balance font-display text-4xl font-semibold leading-tight text-ink md:text-5xl">
            Three products, one direct-growth stack
          </h2>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-gray-600">
            Use the complete platform or start with the part your hotel needs most.
          </p>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[1.05fr_0.95fr] lg:grid-rows-2">
          <article className="overflow-hidden rounded-3xl border border-border bg-[#f7f8fc] lg:row-span-2">
            <div className="p-7 md:p-10">
              <h3 className="font-display text-3xl font-semibold text-ink">Booking Engine</h3>
              <p className="mt-3 max-w-lg leading-relaxed text-gray-600">
                Turn website visitors into direct bookings with branded checkout, upsells and
                referral tracking.
              </p>
              <a href="/booking-engine" className={linkClasses}>
                Explore Booking Engine
                <ArrowRightIcon className="h-4 w-4" />
              </a>
            </div>
            <Image
              src="/booking-preview.jpg"
              alt="Vayada Booking Engine on a hotel website"
              width={1920}
              height={1084}
              sizes="(min-width: 1024px) 50vw, 100vw"
              className="h-auto w-full border-t border-border object-cover"
            />
          </article>

          <article className="grid overflow-hidden rounded-3xl border border-border bg-white lg:grid-cols-[0.9fr_1.1fr]">
            <div className="p-7 md:p-8">
              <h3 className="font-display text-2xl font-semibold text-ink">PMS</h3>
              <p className="mt-3 text-sm leading-relaxed text-gray-600">
                Run rooms, rates, reservations and channel inventory from one calm workspace.
              </p>
              <a href="/pms" className={linkClasses}>
                Explore PMS
                <ArrowRightIcon className="h-4 w-4" />
              </a>
            </div>
            <Image
              src="/pms-product-mock.png"
              alt="Vayada PMS reservation calendar"
              width={1920}
              height={1138}
              sizes="(min-width: 1024px) 25vw, 100vw"
              className="h-full min-h-52 w-full border-t border-border object-cover object-left lg:border-l lg:border-t-0"
            />
          </article>

          <article className="grid overflow-hidden rounded-3xl border border-border bg-primary-50 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="p-7 md:p-8">
              <h3 className="font-display text-2xl font-semibold text-ink">Creator Marketplace</h3>
              <p className="mt-3 text-sm leading-relaxed text-gray-600">
                Find vetted creators, manage hotel stays and turn trusted recommendations into
                direct demand.
              </p>
              <a href="/hotel-creator-network" className={linkClasses}>
                Explore Creator Marketplace
                <ArrowRightIcon className="h-4 w-4" />
              </a>
            </div>
            <Image
              src="/hcn-network-mock.png"
              alt="Vayada Creator Marketplace with hotel and creator profiles"
              width={1920}
              height={1199}
              sizes="(min-width: 1024px) 25vw, 100vw"
              className="h-full min-h-52 w-full border-t border-primary-100 object-cover object-left lg:border-l lg:border-t-0"
            />
          </article>
        </div>
      </div>
    </section>
  );
}
