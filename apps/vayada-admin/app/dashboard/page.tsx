"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { usersService } from "@/services/api";
import { ApiErrorResponse } from "@/services/api/client";
import { Button, Input } from "@/components/ui";
import type { User } from "@/lib/types";
import {
  MagnifyingGlassIcon,
  UserIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Modal } from "@/components/ui/Modal";

type FilterType = "all" | "hotel" | "creator" | "admin";
type FilterStatus = "all" | "pending" | "verified" | "rejected" | "suspended";

const VALID_TYPES: FilterType[] = ["all", "hotel", "creator", "admin"];
const VALID_STATUSES: FilterStatus[] = ["all", "pending", "verified", "rejected", "suspended"];

const SCROLL_STORAGE_KEY = "admin:users-list:scroll";

function findScrollContainer(node: HTMLElement | null): HTMLElement | Window {
  let current: HTMLElement | null = node?.parentElement ?? null;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

function getScrollTop(target: HTMLElement | Window): number {
  return target instanceof Window ? target.scrollY : target.scrollTop;
}

function setScrollTop(target: HTMLElement | Window, top: number): void {
  if (target instanceof Window) {
    target.scrollTo(0, top);
  } else {
    target.scrollTop = top;
  }
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") ?? "");
  const [filterType, setFilterType] = useState<FilterType>(() => {
    const value = searchParams.get("type") as FilterType | null;
    return value && VALID_TYPES.includes(value) ? value : "all";
  });
  const [filterStatus, setFilterStatus] = useState<FilterStatus>(() => {
    const value = searchParams.get("status") as FilterStatus | null;
    return value && VALID_STATUSES.includes(value) ? value : "all";
  });

  // Pagination
  const [page, setPage] = useState(() => {
    const parsed = Number(searchParams.get("page"));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  });
  const [pageSize] = useState(100);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  // Anchor for locating the scroll container we live inside (the dashboard
  // layout's <main overflow-auto>).
  const rootRef = useRef<HTMLDivElement | null>(null);
  // One-shot flag so we only restore scroll once per mount, after the first
  // successful list load.
  const scrollRestoredRef = useRef(false);
  // Holds the latest URL that mirrors filter/search/page state, so we can
  // flush it synchronously on row click before the route changes.
  const pendingUrlRef = useRef<string>("/dashboard");

  const buildListUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (filterType !== "all") params.set("type", filterType);
    if (filterStatus !== "all") params.set("status", filterStatus);
    if (searchTerm) params.set("q", searchTerm);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return query ? `/dashboard?${query}` : "/dashboard";
  }, [filterType, filterStatus, searchTerm, page]);

  // Mirror filter state into the URL so navigating away and back restores
  // the user's view. Debounced to avoid churning history while typing.
  useEffect(() => {
    const next = buildListUrl();
    pendingUrlRef.current = next;
    const timer = setTimeout(() => {
      router.replace(next, { scroll: false });
    }, 200);
    return () => clearTimeout(timer);
  }, [buildListUrl, router]);

  // Modal state
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const [debouncedSearch, setDebouncedSearch] = useState(searchTerm);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filterType, filterStatus]);

  useEffect(() => {
    loadUsers();
  }, [page, filterType, filterStatus, debouncedSearch]);

  // After the first successful load, restore the scroll position the user
  // was at when they navigated away to a user detail page.
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (loading) return;
    if (typeof window === "undefined") return;
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    if (raw === null) {
      scrollRestoredRef.current = true;
      return;
    }
    sessionStorage.removeItem(SCROLL_STORAGE_KEY);
    scrollRestoredRef.current = true;
    const offset = Number(raw);
    if (!Number.isFinite(offset) || offset <= 0) return;
    const target = findScrollContainer(rootRef.current);
    // Wait one frame so the just-rendered table has its real height before
    // we try to scroll — otherwise the browser clamps to a too-short page.
    requestAnimationFrame(() => setScrollTop(target, offset));
  }, [loading]);

  // Save scroll position and flush filter URL, then navigate to a route that
  // we want users to be able to "come back" from (currently: user detail).
  const navigateAndRemember = (href: string) => {
    if (typeof window !== "undefined") {
      const target = findScrollContainer(rootRef.current);
      sessionStorage.setItem(SCROLL_STORAGE_KEY, String(getScrollTop(target)));
      router.replace(pendingUrlRef.current, { scroll: false });
    }
    router.push(href);
  };

  const loadUsers = async () => {
    try {
      setLoading(true);
      setError("");

      const params: any = {
        page,
        page_size: pageSize,
      };
      if (filterType !== "all") params.type = filterType;
      if (filterStatus !== "all") params.status = filterStatus;
      if (debouncedSearch) params.search = debouncedSearch;

      const response = await usersService.getAllUsers(params);
      setUsers(response.users || []);
      setTotal(response.total || 0);
      setTotalPages(Math.ceil((response.total || 0) / pageSize));
    } catch (err) {
      console.error("Error loading users:", err);
      if (err instanceof ApiErrorResponse) {
        if (err.status === 404) {
          setError(
            "Backend endpoint /api/identity/admin/users not found. Please ensure the backend API is running and the endpoint is configured.",
          );
        } else if (err.status === 401) {
          setError("Authentication failed. Please login again.");
          authService.logout();
        } else if (err.status === 403) {
          setError("Access denied. Admin privileges required.");
        } else {
          const detail = err.data.detail;
          const errorMessage =
            typeof detail === "string"
              ? detail
              : Array.isArray(detail)
                ? detail.map((d: any) => d.msg || JSON.stringify(d)).join(", ")
                : JSON.stringify(detail) || "Failed to load users";
          setError(errorMessage);
        }
      } else {
        setError("Failed to load users. Please check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setDebouncedSearch(searchTerm);
    setPage(1);
  };

  const handleDeleteUser = async () => {
    if (!deleteConfirmUser) return;

    try {
      setDeleting(true);
      setDeleteError("");
      setSuccessMessage("");

      await usersService.deleteUser(deleteConfirmUser.id);

      // Remove user from list
      setUsers((prev) => prev.filter((u) => u.id !== deleteConfirmUser.id));
      setTotal((prev) => prev - 1);

      // Close modals
      setDeleteConfirmUser(null);

      // Show success message
      setSuccessMessage(`User "${deleteConfirmUser.name}" has been deleted successfully.`);

      // Clear success message after 5 seconds
      setTimeout(() => setSuccessMessage(""), 5000);
    } catch (err) {
      console.error("Error loading users:", err);
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400 && err.message.toLowerCase().includes("own account")) {
          setDeleteError("Cannot delete your own account.");
        } else if (err.status === 404) {
          setDeleteError("User not found.");
        } else if (err.status === 403) {
          setDeleteError("Access denied. Admin privileges required.");
        } else {
          const detail = err.data.detail;
          const errorMessage =
            typeof detail === "string"
              ? detail
              : Array.isArray(detail)
                ? detail.map((d: any) => d.msg || JSON.stringify(d)).join(", ")
                : err.message || "Failed to delete user.";
          setDeleteError(errorMessage);
        }
      } else {
        setDeleteError("Failed to delete user. Please try again.");
      }
    } finally {
      setDeleting(false);
    }
  };

  const getStatusBadgeColor = (status: User["status"]) => {
    switch (status) {
      case "verified":
        return "bg-green-100 text-green-800";
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      case "suspended":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getTypeBadgeColor = (type: User["type"]) => {
    switch (type) {
      case "admin":
        return "bg-purple-100 text-purple-800";
      case "hotel":
        return "bg-blue-100 text-blue-800";
      case "creator":
        return "bg-indigo-100 text-indigo-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  return (
    <div ref={rootRef} className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Users</h1>
            <p className="text-sm text-gray-500">Manage all users in the system</p>
          </div>
          <Button variant="primary" onClick={() => router.push("/dashboard/users/create")}>
            <PlusIcon className="w-5 h-5 mr-2" />
            Create User
          </Button>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        {/* Filters and Search */}
        <div className="mb-6 bg-white p-4 rounded-lg shadow">
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search by name or email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <div className="flex gap-4">
              <select
                value={filterType}
                onChange={(e) => {
                  setFilterType(e.target.value as any);
                  setPage(1);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
              >
                <option value="all">All Types</option>
                <option value="hotel">Hotels</option>
                <option value="creator">Creators</option>
                <option value="admin">Admins</option>
              </select>
              <select
                value={filterStatus}
                onChange={(e) => {
                  setFilterStatus(e.target.value as any);
                  setPage(1);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="verified">Verified</option>
                <option value="rejected">Rejected</option>
                <option value="suspended">Suspended</option>
              </select>
              <Button type="submit" variant="primary">
                Search
              </Button>
            </div>
          </form>
        </div>

        {error && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-sm text-yellow-800">{error}</p>
          </div>
        )}

        {successMessage && (
          <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-sm text-green-800">{successMessage}</p>
          </div>
        )}

        {/* Users Table */}
        {loading ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <p className="text-gray-600">Loading users...</p>
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <UserIcon className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No users found</h3>
            <p className="mt-1 text-sm text-gray-500">
              Try adjusting your filters or search terms.
            </p>
          </div>
        ) : (
          <>
            <div className="bg-white shadow overflow-hidden sm:rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Email Verified
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => navigateAndRemember(`/dashboard/users/${user.id}`)}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10">
                            {user.avatar ? (
                              <img
                                className="h-10 w-10 rounded-full object-cover bg-gray-200"
                                src={user.avatar}
                                alt={user.name}
                                onError={(e) => {
                                  const img = e.currentTarget;
                                  img.style.display = "none";
                                  const fallback = img.nextElementSibling as HTMLElement | null;
                                  if (fallback) fallback.style.display = "flex";
                                }}
                              />
                            ) : null}
                            <div
                              className="h-10 w-10 rounded-full bg-gray-200 items-center justify-center"
                              style={{ display: user.avatar ? "none" : "flex" }}
                            >
                              <UserIcon className="h-6 w-6 text-gray-400" />
                            </div>
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">{user.name}</div>
                            <div className="text-sm text-gray-500">{user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getTypeBadgeColor(user.type)}`}
                        >
                          {user.type}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusBadgeColor(user.status)}`}
                        >
                          {user.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {user.email_verified ? (
                          <span className="text-green-600 font-medium">Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(user.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmUser(user);
                          }}
                          className="text-red-600 hover:text-red-900 transition-colors"
                          title="Delete user"
                        >
                          <TrashIcon className="h-5 w-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-between bg-white px-4 py-3 rounded-lg shadow sm:px-6">
                <div className="flex flex-1 justify-between sm:hidden">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    Next
                  </Button>
                </div>
                <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm text-gray-700">
                      Showing <span className="font-medium">{startItem}</span> to{" "}
                      <span className="font-medium">{endItem}</span> of{" "}
                      <span className="font-medium">{total}</span> results
                    </p>
                  </div>
                  <div>
                    <nav
                      className="isolate inline-flex -space-x-px rounded-md shadow-sm"
                      aria-label="Pagination"
                    >
                      <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="relative inline-flex items-center rounded-l-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ArrowLeftIcon className="w-5 h-5" />
                      </button>
                      {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
                        let pageNum: number;
                        if (totalPages <= 10) {
                          pageNum = i + 1;
                        } else if (page <= 5) {
                          pageNum = i + 1;
                        } else if (page >= totalPages - 4) {
                          pageNum = totalPages - 9 + i;
                        } else {
                          pageNum = page - 5 + i;
                        }

                        return (
                          <button
                            key={pageNum}
                            onClick={() => setPage(pageNum)}
                            className={`relative inline-flex items-center px-4 py-2 text-sm font-semibold ${
                              pageNum === page
                                ? "z-10 bg-primary-600 text-white focus:z-20"
                                : "text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0"
                            }`}
                          >
                            {pageNum}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page === totalPages}
                        className="relative inline-flex items-center rounded-r-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ArrowRightIcon className="w-5 h-5" />
                      </button>
                    </nav>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* Delete Confirmation Modal */}
        {deleteConfirmUser && (
          <Modal
            isOpen={!!deleteConfirmUser}
            onClose={() => {
              setDeleteConfirmUser(null);
              setDeleteError("");
            }}
            title="Delete User"
            size="md"
          >
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm font-medium text-red-800">
                  ⚠️ Warning: This action cannot be undone!
                </p>
              </div>

              <div>
                <p className="text-sm text-gray-700 mb-2">
                  Are you sure you want to delete this user? This will permanently delete:
                </p>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1 ml-4">
                  <li>
                    User account: <strong>{deleteConfirmUser.name}</strong> (
                    {deleteConfirmUser.email})
                  </li>
                  {deleteConfirmUser.type === "creator" && (
                    <li>Creator profile and all social media platforms</li>
                  )}
                  {deleteConfirmUser.type === "hotel" && (
                    <li>
                      Hotel profile and all collaboration offers with compensation and requirements
                    </li>
                  )}
                  <li>All associated S3 images (profile pictures, media, thumbnails)</li>
                  <li>All related records</li>
                </ul>
              </div>

              {deleteError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-800">{deleteError}</p>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeleteConfirmUser(null);
                    setDeleteError("");
                  }}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleDeleteUser}
                  disabled={deleting}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {deleting ? "Deleting..." : "Delete User"}
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="p-6" />}>
      <DashboardContent />
    </Suspense>
  );
}
