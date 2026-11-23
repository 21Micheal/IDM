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

export interface OutstandingRetirementLine {
  id: string;
  document_id?: string;
  document_reference: string;
  title: string;
  document_status: string;
  workflow_phase: string;
  created_at: string;
  traveller_name: string;
  traveller_email: string;
  department: string;
  departure_date: string;
  return_date: string;
  due_date: string;
  days_overdue: number;
  aging_bucket: "current" | "1_30" | "31_60" | "61_90" | "over_90" | "reconciled";
  aging_bucket_label: string;
  advance_amount: number;
  retired_amount: number;
  outstanding_amount: number;
  variance_amount: number;
  variance_scenario: string;
  currency: string;
  retirement_status: string;
  retirement_status_label: string;
}

export interface AgingBucketTotal {
  count: number;
  amount: number;
}

export interface RetirementAgingSummary {
  total_records: number;
  total_advance_amount: number;
  total_outstanding_amount: number;
  total_retired_amount: number;
  total_overdue_records: number;
  total_overdue_amount: number;
  total_awaiting_finance: number;
  total_reconciled: number;
  average_days_aged: number;
  aging_totals: Record<string, AgingBucketTotal>;
}

export interface DepartmentAgingSummary {
  department: string;
  total_records: number;
  total_advance: number;
  total_outstanding: number;
  total_retired: number;
  overdue_count: number;
  overdue_amount: number;
  aging_buckets: {
    current: number;
    "1_30": number;
    "31_60": number;
    "61_90": number;
    "over_90": number;
    reconciled: number;
  };
}

export interface TravellerAgingSummary {
  traveller_name: string;
  traveller_email: string;
  department: string;
  total_records: number;
  total_advance: number;
  total_outstanding: number;
  total_retired: number;
  overdue_count: number;
  overdue_amount: number;
  aging_buckets: {
    current: number;
    "1_30": number;
    "31_60": number;
    "61_90": number;
    "over_90": number;
    reconciled: number;
  };
}

export interface RetirementsAgingReportFilterOptions {
  departments: string[];
  travellers: string[];
  statuses: Array<{ key: string; label: string }>;
  aging_buckets: Array<{ key: string; label: string }>;
}

export interface RetirementsAgingReportResponse {
  summary: RetirementAgingSummary;
  retirements: OutstandingRetirementLine[];
  by_department: DepartmentAgingSummary[];
  by_traveller: TravellerAgingSummary[];
  filter_options: RetirementsAgingReportFilterOptions;
}

export interface RetirementsAgingReportParams {
  search?: string;
  department?: string;
  traveller?: string;
  status?: string;
  aging_bucket?: string;
  start_date?: string;
  end_date?: string;
  include_reconciled?: boolean | string;
  export?: string;
}


