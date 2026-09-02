"use client";

import { TextareaHTMLAttributes, forwardRef } from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, className = "", ...props }, ref) => {
    const feedbackId = props.id && (error || helperText) ? `${props.id}-feedback` : undefined;
    const describedBy =
      [props["aria-describedby"], feedbackId].filter(Boolean).join(" ") || undefined;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={props.id} className="block text-sm font-semibold text-gray-700 mb-1.5">
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          className={`
            w-full px-4 py-2.5 
            border rounded-lg 
            text-gray-900 
            placeholder-gray-400
            resize-y min-h-[100px]
            transition-all duration-200
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${error ? "border-red-300 focus:ring-red-500" : "border-gray-300 hover:border-gray-400"}
            ${className}
          `}
          {...props}
          aria-describedby={describedBy}
          aria-invalid={error ? true : props["aria-invalid"]}
        />
        {error && (
          <p id={feedbackId} role="alert" className="mt-1.5 text-sm text-red-600 flex items-center">
            <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            {error}
          </p>
        )}
        {helperText && !error && (
          <p id={feedbackId} className="mt-1.5 text-sm text-gray-500">
            {helperText}
          </p>
        )}
      </div>
    );
  },
);

Textarea.displayName = "Textarea";
