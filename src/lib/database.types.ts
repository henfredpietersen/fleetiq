export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string;
          actor_id: string | null;
          after_values: Json | null;
          before_values: Json | null;
          branch_id: string | null;
          company_id: string | null;
          entity_id: string | null;
          entity_type: string;
          id: string;
          metadata: Json | null;
          occurred_at: string;
          reason: string | null;
          request_reference: string | null;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_id?: string | null;
          after_values?: Json | null;
          before_values?: Json | null;
          branch_id?: string | null;
          company_id?: string | null;
          entity_id?: string | null;
          entity_type: string;
          id?: string;
          metadata?: Json | null;
          occurred_at?: string;
          reason?: string | null;
          request_reference?: string | null;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          after_values?: Json | null;
          before_values?: Json | null;
          branch_id?: string | null;
          company_id?: string | null;
          entity_id?: string | null;
          entity_type?: string;
          id?: string;
          metadata?: Json | null;
          occurred_at?: string;
          reason?: string | null;
          request_reference?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_logs_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      auth_login_attempts: {
        Row: {
          company_id: string | null;
          employee_number_attempted: string;
          id: string;
          ip_hash: string;
          occurred_at: string;
          profile_id: string | null;
          succeeded: boolean;
        };
        ComputedFields: never;
        Insert: {
          company_id?: string | null;
          employee_number_attempted: string;
          id?: string;
          ip_hash: string;
          occurred_at?: string;
          profile_id?: string | null;
          succeeded: boolean;
        };
        Update: {
          company_id?: string | null;
          employee_number_attempted?: string;
          id?: string;
          ip_hash?: string;
          occurred_at?: string;
          profile_id?: string | null;
          succeeded?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "auth_login_attempts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auth_login_attempts_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      background_jobs: {
        Row: {
          attempts: number;
          company_id: string | null;
          created_at: string;
          finished_at: string | null;
          id: string;
          idempotency_key: string;
          job_type: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          payload: NonNullable<Json>;
          result: Json | null;
          run_after: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          company_id?: string | null;
          created_at?: string;
          finished_at?: string | null;
          id?: string;
          idempotency_key: string;
          job_type: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          payload?: NonNullable<Json>;
          result?: Json | null;
          run_after?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          company_id?: string | null;
          created_at?: string;
          finished_at?: string | null;
          id?: string;
          idempotency_key?: string;
          job_type?: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          payload?: NonNullable<Json>;
          result?: Json | null;
          run_after?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "background_jobs_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      branches: {
        Row: {
          address: string | null;
          branch_code: string;
          company_id: string;
          created_at: string;
          id: string;
          name: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          address?: string | null;
          branch_code: string;
          company_id: string;
          created_at?: string;
          id?: string;
          name: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          address?: string | null;
          branch_code?: string;
          company_id?: string;
          created_at?: string;
          id?: string;
          name?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "branches_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      companies: {
        Row: {
          created_at: string;
          id: string;
          legal_name: string | null;
          name: string;
          registration_number: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          legal_name?: string | null;
          name: string;
          registration_number?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          legal_name?: string | null;
          name?: string;
          registration_number?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      departments: {
        Row: {
          branch_id: string | null;
          company_id: string;
          id: string;
          name: string;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id?: string | null;
          company_id: string;
          id?: string;
          name: string;
          status?: string;
        };
        Update: {
          branch_id?: string | null;
          company_id?: string;
          id?: string;
          name?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "departments_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "departments_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      evidence_access_log: {
        Row: {
          access_type: string;
          accessed_by: string;
          branch_id: string | null;
          company_id: string;
          evidence_file_id: string;
          id: string;
          occurred_at: string;
          purpose: string | null;
          related_entity_id: string | null;
          related_entity_type: string | null;
        };
        ComputedFields: never;
        Insert: {
          access_type: string;
          accessed_by: string;
          branch_id?: string | null;
          company_id: string;
          evidence_file_id: string;
          id?: string;
          occurred_at?: string;
          purpose?: string | null;
          related_entity_id?: string | null;
          related_entity_type?: string | null;
        };
        Update: {
          access_type?: string;
          accessed_by?: string;
          branch_id?: string | null;
          company_id?: string;
          evidence_file_id?: string;
          id?: string;
          occurred_at?: string;
          purpose?: string | null;
          related_entity_id?: string | null;
          related_entity_type?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "evidence_access_log_accessed_by_company_id_fkey";
            columns: ["accessed_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "evidence_access_log_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "evidence_access_log_evidence_file_id_fkey";
            columns: ["evidence_file_id"];
            isOneToOne: false;
            referencedRelation: "evidence_files";
            referencedColumns: ["id"];
          },
        ];
      };
      evidence_files: {
        Row: {
          branch_id: string | null;
          bucket: string;
          capture_source: string;
          company_id: string;
          created_at: string;
          device_capture_at: string | null;
          exif_gps_stripped: boolean;
          height: number | null;
          id: string;
          legal_hold: boolean;
          mime_type: string;
          object_path: string;
          perceptual_hash: string | null;
          purpose: string;
          retention_class: string | null;
          server_received_at: string;
          sha256: string;
          size_bytes: number;
          uploaded_by: string;
          width: number | null;
        };
        ComputedFields: never;
        Insert: {
          branch_id?: string | null;
          bucket: string;
          capture_source: string;
          company_id: string;
          created_at?: string;
          device_capture_at?: string | null;
          exif_gps_stripped: boolean;
          height?: number | null;
          id?: string;
          legal_hold?: boolean;
          mime_type: string;
          object_path: string;
          perceptual_hash?: string | null;
          purpose: string;
          retention_class?: string | null;
          server_received_at?: string;
          sha256: string;
          size_bytes: number;
          uploaded_by: string;
          width?: number | null;
        };
        Update: {
          branch_id?: string | null;
          bucket?: string;
          capture_source?: string;
          company_id?: string;
          created_at?: string;
          device_capture_at?: string | null;
          exif_gps_stripped?: boolean;
          height?: number | null;
          id?: string;
          legal_hold?: boolean;
          mime_type?: string;
          object_path?: string;
          perceptual_hash?: string | null;
          purpose?: string;
          retention_class?: string | null;
          server_received_at?: string;
          sha256?: string;
          size_bytes?: number;
          uploaded_by?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "evidence_files_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "evidence_files_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "evidence_files_uploaded_by_company_id_fkey";
            columns: ["uploaded_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      evidence_upload_slots: {
        Row: {
          branch_id: string | null;
          bucket: string;
          capture_source: string;
          client_submission_id: string;
          company_id: string;
          created_at: string;
          declared_mime_type: string;
          declared_size_bytes: number;
          device_capture_at: string | null;
          evidence_file_id: string | null;
          expires_at: string;
          id: string;
          object_path: string;
          object_removed_at: string | null;
          purpose: string;
          requested_by: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id?: string | null;
          bucket?: string;
          capture_source: string;
          client_submission_id: string;
          company_id: string;
          created_at?: string;
          declared_mime_type: string;
          declared_size_bytes: number;
          device_capture_at?: string | null;
          evidence_file_id?: string | null;
          expires_at: string;
          id?: string;
          object_path: string;
          object_removed_at?: string | null;
          purpose: string;
          requested_by: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          branch_id?: string | null;
          bucket?: string;
          capture_source?: string;
          client_submission_id?: string;
          company_id?: string;
          created_at?: string;
          declared_mime_type?: string;
          declared_size_bytes?: number;
          device_capture_at?: string | null;
          evidence_file_id?: string | null;
          expires_at?: string;
          id?: string;
          object_path?: string;
          object_removed_at?: string | null;
          purpose?: string;
          requested_by?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "evidence_slots_file_fk";
            columns: ["evidence_file_id"];
            isOneToOne: false;
            referencedRelation: "evidence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "evidence_upload_slots_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "evidence_upload_slots_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "evidence_upload_slots_requested_by_company_id_fkey";
            columns: ["requested_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      permissions: {
        Row: {
          description: string | null;
          id: string;
          permission_key: string;
          requires_mfa: boolean;
        };
        ComputedFields: never;
        Insert: {
          description?: string | null;
          id?: string;
          permission_key: string;
          requires_mfa?: boolean;
        };
        Update: {
          description?: string | null;
          id?: string;
          permission_key?: string;
          requires_mfa?: boolean;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          company_id: string;
          created_at: string;
          display_name: string;
          email: string | null;
          id: string;
          locked_until: string | null;
          login_identifier: string;
          must_change_pin: boolean;
          phone: string | null;
          pin_set_at: string | null;
          status: string;
          updated_at: string;
          user_type: string;
        };
        ComputedFields: never;
        Insert: {
          company_id: string;
          created_at?: string;
          display_name: string;
          email?: string | null;
          id: string;
          locked_until?: string | null;
          login_identifier: string;
          must_change_pin?: boolean;
          phone?: string | null;
          pin_set_at?: string | null;
          status?: string;
          updated_at?: string;
          user_type: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          display_name?: string;
          email?: string | null;
          id?: string;
          locked_until?: string | null;
          login_identifier?: string;
          must_change_pin?: boolean;
          phone?: string | null;
          pin_set_at?: string | null;
          status?: string;
          updated_at?: string;
          user_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      role_permissions: {
        Row: {
          permission_id: string;
          role_id: string;
        };
        ComputedFields: never;
        Insert: {
          permission_id: string;
          role_id: string;
        };
        Update: {
          permission_id?: string;
          role_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey";
            columns: ["permission_id"];
            isOneToOne: false;
            referencedRelation: "permissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
        ];
      };
      roles: {
        Row: {
          company_id: string | null;
          description: string | null;
          id: string;
          name: string;
          requires_mfa: boolean;
        };
        ComputedFields: never;
        Insert: {
          company_id?: string | null;
          description?: string | null;
          id?: string;
          name: string;
          requires_mfa?: boolean;
        };
        Update: {
          company_id?: string | null;
          description?: string | null;
          id?: string;
          name?: string;
          requires_mfa?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "roles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          branch_id: string | null;
          company_id: string;
          created_at: string;
          effective_from: string;
          effective_to: string | null;
          granted_by: string;
          id: string;
          role_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id?: string | null;
          company_id: string;
          created_at?: string;
          effective_from?: string;
          effective_to?: string | null;
          granted_by: string;
          id?: string;
          role_id: string;
          user_id: string;
        };
        Update: {
          branch_id?: string | null;
          company_id?: string;
          created_at?: string;
          effective_from?: string;
          effective_to?: string | null;
          granted_by?: string;
          id?: string;
          role_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_roles_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "user_roles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_granted_by_company_id_fkey";
            columns: ["granted_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "user_roles_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_roles_user_id_company_id_fkey";
            columns: ["user_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      access_cleared: { Args: { p_user: string }; Returns: boolean };
      auth_complete_pin_change: {
        Args: { p_profile: string };
        Returns: undefined;
      };
      auth_issue_pin_flags: {
        Args: { p_actor: string; p_mode: string; p_target: string };
        Returns: undefined;
      };
      auth_lock_profile: {
        Args: { p_profile: string; p_until: string };
        Returns: undefined;
      };
      auth_login_counts: {
        Args: {
          p_emp_hash: string;
          p_ip_hash: string;
          p_profile_id?: string;
          p_window: string;
        };
        Returns: {
          account_failures: number;
          account_last_failure: string;
          ip_failures: number;
          ip_last_failure: string;
        }[];
      };
      auth_login_record: {
        Args: {
          p_company: string;
          p_emp_hash: string;
          p_ip_hash: string;
          p_profile: string;
          p_succeeded: boolean;
        };
        Returns: undefined;
      };
      can_view_evidence: {
        Args: {
          p_branch_id: string;
          p_company_id: string;
          p_purpose: string;
          p_uploaded_by: string;
        };
        Returns: boolean;
      };
      claim_abandoned_evidence_slots: {
        Args: { p_grace_minutes: number; p_limit?: number };
        Returns: {
          bucket: string;
          id: string;
          object_path: string;
        }[];
      };
      claim_background_job: {
        Args: {
          p_job_types: string[];
          p_lock_timeout?: string;
          p_worker: string;
        };
        Returns: {
          attempts: number;
          company_id: string | null;
          created_at: string;
          finished_at: string | null;
          id: string;
          idempotency_key: string;
          job_type: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          payload: NonNullable<Json>;
          result: Json | null;
          run_after: string;
          status: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "background_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      complete_background_job: {
        Args: { p_id: string; p_result?: Json; p_worker: string };
        Returns: boolean;
      };
      current_company_id: { Args: Record<PropertyKey, never>; Returns: string };
      current_user_requires_mfa: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      enqueue_background_job: {
        Args: {
          p_company_id?: string;
          p_idempotency_key: string;
          p_job_type: string;
          p_max_attempts?: number;
          p_payload?: Json;
          p_run_after?: string;
        };
        Returns: string;
      };
      evidence_object_readable: {
        Args: { p_bucket: string; p_path: string };
        Returns: boolean;
      };
      evidence_scope_allows: {
        Args: { p_branch_id: string; p_purpose: string; p_uploaded_by: string };
        Returns: boolean;
      };
      evidence_slot_open_for_upload: {
        Args: { p_bucket: string; p_path: string };
        Returns: boolean;
      };
      evidence_upload_permission: {
        Args: { p_purpose: string };
        Returns: string;
      };
      fail_background_job: {
        Args: {
          p_error: string;
          p_id: string;
          p_retry_in?: string;
          p_worker: string;
        };
        Returns: string;
      };
      has_permission: {
        Args: { permission_key: string; target_branch_id: string };
        Returns: boolean;
      };
      issue_evidence_access: {
        Args: {
          p_evidence_file_id: string;
          p_purpose?: string;
          p_related_entity_id?: string;
          p_related_entity_type?: string;
        };
        Returns: {
          bucket: string;
          object_path: string;
        }[];
      };
      mark_evidence_slots_object_removed: {
        Args: { p_ids: string[] };
        Returns: number;
      };
      register_evidence_file: {
        Args: {
          p_exif_gps_stripped: boolean;
          p_height: number;
          p_mime_type: string;
          p_sha256: string;
          p_size_bytes: number;
          p_slot_id: string;
          p_user_id: string;
          p_width: number;
        };
        Returns: string;
      };
      request_evidence_upload_slot: {
        Args: {
          p_branch_id: string;
          p_capture_source: string;
          p_client_submission_id: string;
          p_device_capture_at?: string;
          p_mime_type: string;
          p_purpose: string;
          p_size_bytes: number;
          p_ttl_minutes?: number;
        };
        Returns: {
          branch_id: string | null;
          bucket: string;
          capture_source: string;
          client_submission_id: string;
          company_id: string;
          created_at: string;
          declared_mime_type: string;
          declared_size_bytes: number;
          device_capture_at: string | null;
          evidence_file_id: string | null;
          expires_at: string;
          id: string;
          object_path: string;
          object_removed_at: string | null;
          purpose: string;
          requested_by: string;
          status: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "evidence_upload_slots";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      user_requires_mfa: { Args: { p_user: string }; Returns: boolean };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
