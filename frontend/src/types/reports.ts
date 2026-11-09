export interface RequisitionReportLine {
  id: string;
  document_id: string;
  document_reference: string;
  document_title: string;
  document_status: string;
  date: string;
  department: string;
  requester: string;
  table_name: string;
  activity_code: string;
  activity_description: string;
  account_code: string;
  cost_centre: string;
  description: string;
  amount: number;
  currency: string;
  journal_number: string;
  journal_status: "posted" | "pending" | "failed" | "unposted";
}

export interface RequisitionReportSummary {
  total_amount: number;
  total_lines: number;
  posted_amount: number;
  posted_lines: number;
  distinct_activities: number;
  distinct_accounts: number;
}

export interface RequisitionReportActivityGroup {
  activity_code: string;
  activity_description: string;
  line_count: number;
  total_amount: number;
  posted_amount: number;
  currency: string;
}

export interface RequisitionReportAccountGroup {
  account_code: string;
  line_count: number;
  total_amount: number;
  posted_amount: number;
  currency: string;
}

export interface RequisitionReportFilterOptions {
  accounts: string[];
  activities: string[];
  departments: string[];
  statuses: string[];
}

export interface RequisitionReportResponse {
  summary: RequisitionReportSummary;
  lines: RequisitionReportLine[];
  by_activity: RequisitionReportActivityGroup[];
  by_account: RequisitionReportAccountGroup[];
  filter_options: RequisitionReportFilterOptions;
}

export interface RequisitionReportParams {
  search?: string;
  start_date?: string;
  end_date?: string;
  account_code?: string;
  activity_code?: string;
  status?: string;
  department?: string;
  has_journal?: boolean | string;
}

