import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastContainer } from "react-toastify";
import App from "./App";
import "react-toastify/dist/ReactToastify.css";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes default
      gcTime: 1000 * 60 * 10,   // 10 minutes garbage collection
      retry: 1,
    },
  },
});

// Set shorter stale times for dynamic data to ensure consistency
queryClient.setDefaultOptions({
  queries: {
    retry: (failureCount, error: any) => {
      // Don't retry on 401/403 auth errors
      if (error?.response?.status === 401 || error?.response?.status === 403) {
        return false;
      }
      return failureCount < 1;
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ToastContainer position="top-right" autoClose={4000} />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
