"use client";

import { SupportButton } from "@vayada/settings-ui";
import { apiClient } from "@/services/api/client";

import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { authService } from "@/services/auth";

interface NavbarProps {
  userName: string;
  userInitials: string;
}

export default function Navbar({ userName, userInitials }: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <SupportButton
        product="affiliate"
        submit={(request) =>
          apiClient.post("/api/support", request, {
            signal: AbortSignal.timeout(20000),
            redirectOnUnauthorized: false,
          })
        }
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <a href="/dashboard" className="text-gray-900 font-semibold text-sm">
              Affiliate Portal
            </a>
            <div className="hidden sm:flex items-center gap-4 ml-6">
              <a
                href="/dashboard"
                className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                Dashboard
              </a>
              <a
                href="/settings"
                className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                Settings
              </a>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-sm text-gray-600">{userName}</span>
            <div className="w-9 h-9 rounded-full bg-primary-800 text-white flex items-center justify-center text-sm font-medium">
              {userInitials}
            </div>
            <button
              onClick={() => authService.logout()}
              className="hidden sm:inline-flex text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
            >
              Sign out
            </button>
            <button
              className="sm:hidden p-1.5 text-gray-500"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <XMarkIcon className="w-5 h-5" />
              ) : (
                <Bars3Icon className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="sm:hidden border-t border-gray-100 bg-white px-4 py-3 space-y-2">
          <a href="/dashboard" className="block text-sm text-gray-700 py-1.5">
            Dashboard
          </a>
          <a href="/settings" className="block text-sm text-gray-700 py-1.5">
            Settings
          </a>
          <button
            onClick={() => authService.logout()}
            className="block text-sm text-error-600 py-1.5 w-full text-left"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
