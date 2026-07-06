"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (searchParams.get("expired") === "true") {
      setSessionExpired(true);
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("auth") !== "callback") return;
    let cancelled = false;
    setIsSubmitting(true);
    authService
      .refreshSession()
      .then(() => {
        if (!cancelled) router.push("/dashboard");
      })
      .catch((error) => {
        if (!cancelled) {
          setSubmitError(
            error instanceof Error ? error.message : "Login failed. Please try again.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsSubmitting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.login({ email, password });
      router.push("/dashboard");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">V</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Vayada Admin</h1>
          <p className="text-[13px] text-gray-500 mt-1">Sign in to access the admin panel</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          {sessionExpired && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
              <p className="text-sm font-medium text-yellow-800">
                Your session has expired. Please sign in again.
              </p>
            </div>
          )}
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          {submitError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">{submitError}</p>
            </div>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-60"
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginContent />
    </Suspense>
  );
}
