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
      allocation_events: {
        Row: {
          actor_id: string;
          allocation_id: string;
          company_id: string;
          event_type: string;
          id: string;
          metadata: NonNullable<Json>;
          new_value: Json | null;
          occurred_at: string;
          previous_value: Json | null;
          reason: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          allocation_id: string;
          company_id: string;
          event_type: string;
          id?: string;
          metadata?: NonNullable<Json>;
          new_value?: Json | null;
          occurred_at?: string;
          previous_value?: Json | null;
          reason?: string | null;
        };
        Update: {
          actor_id?: string;
          allocation_id?: string;
          company_id?: string;
          event_type?: string;
          id?: string;
          metadata?: NonNullable<Json>;
          new_value?: Json | null;
          occurred_at?: string;
          previous_value?: Json | null;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "allocation_events_actor_id_company_id_fkey";
            columns: ["actor_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "allocation_events_allocation_id_company_id_fkey";
            columns: ["allocation_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicle_allocations";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "allocation_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      approvals: {
        Row: {
          approval_type: string;
          assigned_approver: string | null;
          branch_id: string | null;
          client_submission_id: string | null;
          company_id: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_notes: string | null;
          entity_id: string;
          entity_type: string;
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
          requested_by: string;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          approval_type: string;
          assigned_approver?: string | null;
          branch_id?: string | null;
          client_submission_id?: string | null;
          company_id: string;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_notes?: string | null;
          entity_id: string;
          entity_type: string;
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
          requested_by: string;
          status?: string;
        };
        Update: {
          approval_type?: string;
          assigned_approver?: string | null;
          branch_id?: string | null;
          client_submission_id?: string | null;
          company_id?: string;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_notes?: string | null;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
          requested_by?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "approvals_assigned_approver_company_id_fkey";
            columns: ["assigned_approver", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "approvals_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "approvals_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "approvals_decided_by_company_id_fkey";
            columns: ["decided_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "approvals_requested_by_company_id_fkey";
            columns: ["requested_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
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
      driver_licences: {
        Row: {
          client_submission_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          driver_id: string;
          evidence_file_id: string | null;
          expiry_date: string;
          id: string;
          issue_date: string;
          licence_code: string;
          licence_number: string;
          prdp_expiry_date: string | null;
          prdp_required: boolean;
          verification_status: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          client_submission_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          driver_id: string;
          evidence_file_id?: string | null;
          expiry_date: string;
          id?: string;
          issue_date: string;
          licence_code: string;
          licence_number: string;
          prdp_expiry_date?: string | null;
          prdp_required?: boolean;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          client_submission_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          driver_id?: string;
          evidence_file_id?: string | null;
          expiry_date?: string;
          id?: string;
          issue_date?: string;
          licence_code?: string;
          licence_number?: string;
          prdp_expiry_date?: string | null;
          prdp_required?: boolean;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "driver_licences_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "driver_licences_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "driver_licences_driver_id_company_id_fkey";
            columns: ["driver_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "drivers";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "driver_licences_evidence_file_id_fkey";
            columns: ["evidence_file_id"];
            isOneToOne: false;
            referencedRelation: "evidence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "driver_licences_verified_by_company_id_fkey";
            columns: ["verified_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      drivers: {
        Row: {
          active_status: string;
          branch_id: string;
          company_id: string;
          created_at: string;
          employee_number: string;
          id: string;
          profile_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active_status?: string;
          branch_id: string;
          company_id: string;
          created_at?: string;
          employee_number: string;
          id?: string;
          profile_id: string;
          updated_at?: string;
        };
        Update: {
          active_status?: string;
          branch_id?: string;
          company_id?: string;
          created_at?: string;
          employee_number?: string;
          id?: string;
          profile_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "drivers_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "drivers_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "drivers_profile_id_company_id_fkey";
            columns: ["profile_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
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
          url_expires_at: string | null;
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
          url_expires_at?: string | null;
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
          url_expires_at?: string | null;
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
      service_import_batches: {
        Row: {
          client_submission_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          filename: string;
          id: string;
        };
        ComputedFields: never;
        Insert: {
          client_submission_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          filename: string;
          id?: string;
        };
        Update: {
          client_submission_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          filename?: string;
          id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "service_import_batches_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "service_import_batches_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      service_import_rows: {
        Row: {
          batch_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          errors: string[];
          id: string;
          invoice_reference: string | null;
          job_reference: string | null;
          odometer_km: number | null;
          odometer_raw: string | null;
          registration_number: string | null;
          row_number: number;
          row_status: string;
          service_date: string | null;
          service_date_raw: string | null;
          service_record_id: string | null;
          service_type: string | null;
          supplier_name: string | null;
          vehicle_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          batch_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          errors?: string[];
          id?: string;
          invoice_reference?: string | null;
          job_reference?: string | null;
          odometer_km?: number | null;
          odometer_raw?: string | null;
          registration_number?: string | null;
          row_number: number;
          row_status: string;
          service_date?: string | null;
          service_date_raw?: string | null;
          service_record_id?: string | null;
          service_type?: string | null;
          supplier_name?: string | null;
          vehicle_id?: string | null;
        };
        Update: {
          batch_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          errors?: string[];
          id?: string;
          invoice_reference?: string | null;
          job_reference?: string | null;
          odometer_km?: number | null;
          odometer_raw?: string | null;
          registration_number?: string | null;
          row_number?: number;
          row_status?: string;
          service_date?: string | null;
          service_date_raw?: string | null;
          service_record_id?: string | null;
          service_type?: string | null;
          supplier_name?: string | null;
          vehicle_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "service_import_rows_batch_id_company_id_fkey";
            columns: ["batch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "service_import_batches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_import_rows_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "service_import_rows_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_import_rows_service_record_id_company_id_fkey";
            columns: ["service_record_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "service_records";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_import_rows_vehicle_id_company_id_fkey";
            columns: ["vehicle_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      service_records: {
        Row: {
          actual_service_lifetime_km: number | null;
          actual_service_odometer_km: number;
          branch_id: string;
          client_submission_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          evidence_file_id: string | null;
          id: string;
          invoice_reference: string | null;
          job_reference: string | null;
          labour_cost: number | null;
          parts_cost: number | null;
          rejected_at: string | null;
          rejected_by: string | null;
          rejection_reason: string | null;
          service_date: string;
          service_type: string;
          source: string;
          supplier_name: string | null;
          total_cost: number | null;
          vehicle_id: string;
          verification_status: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          actual_service_lifetime_km?: number | null;
          actual_service_odometer_km: number;
          branch_id: string;
          client_submission_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          evidence_file_id?: string | null;
          id?: string;
          invoice_reference?: string | null;
          job_reference?: string | null;
          labour_cost?: number | null;
          parts_cost?: number | null;
          rejected_at?: string | null;
          rejected_by?: string | null;
          rejection_reason?: string | null;
          service_date: string;
          service_type: string;
          source: string;
          supplier_name?: string | null;
          total_cost?: number | null;
          vehicle_id: string;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          actual_service_lifetime_km?: number | null;
          actual_service_odometer_km?: number;
          branch_id?: string;
          client_submission_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          evidence_file_id?: string | null;
          id?: string;
          invoice_reference?: string | null;
          job_reference?: string | null;
          labour_cost?: number | null;
          parts_cost?: number | null;
          rejected_at?: string | null;
          rejected_by?: string | null;
          rejection_reason?: string | null;
          service_date?: string;
          service_type?: string;
          source?: string;
          supplier_name?: string | null;
          total_cost?: number | null;
          vehicle_id?: string;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "service_records_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_records_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "service_records_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_records_evidence_file_id_fkey";
            columns: ["evidence_file_id"];
            isOneToOne: false;
            referencedRelation: "evidence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "service_records_rejected_by_company_id_fkey";
            columns: ["rejected_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_records_vehicle_id_company_id_fkey";
            columns: ["vehicle_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "service_records_verified_by_company_id_fkey";
            columns: ["verified_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      shift_templates: {
        Row: {
          branch_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          crosses_midnight: boolean;
          end_time: string;
          id: string;
          name: string;
          start_time: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          crosses_midnight: boolean;
          end_time: string;
          id?: string;
          name: string;
          start_time: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          branch_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          crosses_midnight?: boolean;
          end_time?: string;
          id?: string;
          name?: string;
          start_time?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_templates_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "shift_templates_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shift_templates_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      shifts: {
        Row: {
          actual_end_at: string | null;
          actual_start_at: string | null;
          branch_id: string;
          cancel_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          client_submission_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          department_id: string | null;
          id: string;
          scheduled_end_at: string;
          scheduled_start_at: string;
          shift_date: string;
          shift_template_id: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          actual_end_at?: string | null;
          actual_start_at?: string | null;
          branch_id: string;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          client_submission_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          department_id?: string | null;
          id?: string;
          scheduled_end_at: string;
          scheduled_start_at: string;
          shift_date: string;
          shift_template_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          actual_end_at?: string | null;
          actual_start_at?: string | null;
          branch_id?: string;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          client_submission_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          department_id?: string | null;
          id?: string;
          scheduled_end_at?: string;
          scheduled_start_at?: string;
          shift_date?: string;
          shift_template_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shifts_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "shifts_cancelled_by_company_id_fkey";
            columns: ["cancelled_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "shifts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shifts_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "shifts_department_id_fkey";
            columns: ["department_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shifts_shift_template_id_branch_id_company_id_fkey";
            columns: ["shift_template_id", "branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "shift_templates";
            referencedColumns: ["id", "branch_id", "company_id"];
          },
        ];
      };
      staff_password_authorisations: {
        Row: {
          actor_id: string;
          company_id: string;
          consumed_at: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          company_id: string;
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          user_id: string;
        };
        Update: {
          actor_id?: string;
          company_id?: string;
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "staff_password_authorisations_actor_id_company_id_fkey";
            columns: ["actor_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "staff_password_authorisations_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_password_authorisations_user_id_company_id_fkey";
            columns: ["user_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
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
      vehicle_allocations: {
        Row: {
          active_period: unknown;
          allocation_type: string;
          branch_id: string;
          client_submission_id: string;
          closed_by: string | null;
          company_id: string;
          created_at: string;
          created_by: string;
          driver_id: string;
          id: string;
          licence_class_check: string;
          licence_override_approval_id: string | null;
          opened_at: string | null;
          opened_by: string | null;
          opened_on_behalf: boolean;
          planned_end_at: string;
          planned_start_at: string;
          previous_allocation_id: string | null;
          released_at: string | null;
          shift_id: string;
          started_at: string | null;
          status: string;
          updated_at: string;
          vehicle_id: string;
        };
        ComputedFields: never;
        Insert: {
          active_period?: never;
          allocation_type?: string;
          branch_id: string;
          client_submission_id: string;
          closed_by?: string | null;
          company_id: string;
          created_at?: string;
          created_by: string;
          driver_id: string;
          id?: string;
          licence_class_check: string;
          licence_override_approval_id?: string | null;
          opened_at?: string | null;
          opened_by?: string | null;
          opened_on_behalf?: boolean;
          planned_end_at: string;
          planned_start_at: string;
          previous_allocation_id?: string | null;
          released_at?: string | null;
          shift_id: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          vehicle_id: string;
        };
        Update: {
          active_period?: never;
          allocation_type?: string;
          branch_id?: string;
          client_submission_id?: string;
          closed_by?: string | null;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          driver_id?: string;
          id?: string;
          licence_class_check?: string;
          licence_override_approval_id?: string | null;
          opened_at?: string | null;
          opened_by?: string | null;
          opened_on_behalf?: boolean;
          planned_end_at?: string;
          planned_start_at?: string;
          previous_allocation_id?: string | null;
          released_at?: string | null;
          shift_id?: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          vehicle_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_allocations_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "va_opened_by_fk";
            columns: ["opened_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_closed_by_company_id_fkey";
            columns: ["closed_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicle_allocations_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_driver_id_company_id_fkey";
            columns: ["driver_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "drivers";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_licence_override_approval_id_company_i_fkey";
            columns: ["licence_override_approval_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "approvals";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_previous_allocation_id_company_id_fkey";
            columns: ["previous_allocation_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicle_allocations";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_shift_id_branch_id_company_id_fkey";
            columns: ["shift_id", "branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id", "branch_id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_allocations_vehicle_id_company_id_fkey";
            columns: ["vehicle_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      vehicle_branch_assignments: {
        Row: {
          approval_id: string | null;
          branch_id: string;
          company_id: string;
          created_at: string;
          created_by: string;
          effective_from: string;
          effective_to: string | null;
          id: string;
          vehicle_id: string;
        };
        ComputedFields: never;
        Insert: {
          approval_id?: string | null;
          branch_id: string;
          company_id: string;
          created_at?: string;
          created_by: string;
          effective_from: string;
          effective_to?: string | null;
          id?: string;
          vehicle_id: string;
        };
        Update: {
          approval_id?: string | null;
          branch_id?: string;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          vehicle_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_branch_assignments_approval_id_company_id_fkey";
            columns: ["approval_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "approvals";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_branch_assignments_branch_id_company_id_fkey";
            columns: ["branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_branch_assignments_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicle_branch_assignments_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_branch_assignments_vehicle_id_company_id_fkey";
            columns: ["vehicle_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      vehicle_documents: {
        Row: {
          company_id: string;
          created_at: string;
          created_by: string;
          document_number: string | null;
          document_type: string;
          evidence_file_id: string;
          expiry_date: string | null;
          id: string;
          issue_date: string | null;
          vehicle_id: string;
          verification_status: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          company_id: string;
          created_at?: string;
          created_by: string;
          document_number?: string | null;
          document_type: string;
          evidence_file_id: string;
          expiry_date?: string | null;
          id?: string;
          issue_date?: string | null;
          vehicle_id: string;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          created_by?: string;
          document_number?: string | null;
          document_type?: string;
          evidence_file_id?: string;
          expiry_date?: string | null;
          id?: string;
          issue_date?: string | null;
          vehicle_id?: string;
          verification_status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_documents_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicle_documents_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_documents_evidence_file_id_fkey";
            columns: ["evidence_file_id"];
            isOneToOne: false;
            referencedRelation: "evidence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicle_documents_vehicle_id_company_id_fkey";
            columns: ["vehicle_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_documents_verified_by_company_id_fkey";
            columns: ["verified_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      vehicle_service_configs: {
        Row: {
          approval_id: string | null;
          approved_by: string | null;
          company_id: string;
          created_at: string;
          created_by: string | null;
          early_tolerance_days: number | null;
          early_tolerance_km: number;
          effective_from: string;
          effective_to: string | null;
          id: string;
          late_tolerance_days: number | null;
          late_tolerance_km: number;
          make: string | null;
          manufacturer_reference: string | null;
          model: string | null;
          reason: string;
          scope: string;
          service_interval_days: number | null;
          service_interval_km: number;
          vehicle_category: string | null;
          vehicle_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          approval_id?: string | null;
          approved_by?: string | null;
          company_id: string;
          created_at?: string;
          created_by?: string | null;
          early_tolerance_days?: number | null;
          early_tolerance_km: number;
          effective_from: string;
          effective_to?: string | null;
          id?: string;
          late_tolerance_days?: number | null;
          late_tolerance_km: number;
          make?: string | null;
          manufacturer_reference?: string | null;
          model?: string | null;
          reason: string;
          scope: string;
          service_interval_days?: number | null;
          service_interval_km: number;
          vehicle_category?: string | null;
          vehicle_id?: string | null;
        };
        Update: {
          approval_id?: string | null;
          approved_by?: string | null;
          company_id?: string;
          created_at?: string;
          created_by?: string | null;
          early_tolerance_days?: number | null;
          early_tolerance_km?: number;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          late_tolerance_days?: number | null;
          late_tolerance_km?: number;
          make?: string | null;
          manufacturer_reference?: string | null;
          model?: string | null;
          reason?: string;
          scope?: string;
          service_interval_days?: number | null;
          service_interval_km?: number;
          vehicle_category?: string | null;
          vehicle_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_service_configs_approval_id_company_id_fkey";
            columns: ["approval_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "approvals";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_service_configs_approved_by_company_id_fkey";
            columns: ["approved_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_service_configs_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicle_service_configs_created_by_company_id_fkey";
            columns: ["created_by", "company_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicle_service_configs_vehicle_id_company_id_fkey";
            columns: ["vehicle_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
      vehicles: {
        Row: {
          administrative_status: string;
          archived_at: string | null;
          company_id: string;
          created_at: string;
          current_branch_id: string;
          current_odometer_km: number;
          current_odometer_reading_id: string | null;
          department_id: string | null;
          engine_number: string | null;
          fleet_number: string;
          fuel_type: string | null;
          id: string;
          make: string;
          model: string;
          model_year: number | null;
          registration_number: string;
          required_licence_code: string | null;
          transmission: string | null;
          updated_at: string;
          variant: string | null;
          vehicle_category: string;
          vin: string | null;
        };
        ComputedFields: never;
        Insert: {
          administrative_status?: string;
          archived_at?: string | null;
          company_id: string;
          created_at?: string;
          current_branch_id: string;
          current_odometer_km?: number;
          current_odometer_reading_id?: string | null;
          department_id?: string | null;
          engine_number?: string | null;
          fleet_number: string;
          fuel_type?: string | null;
          id?: string;
          make: string;
          model: string;
          model_year?: number | null;
          registration_number: string;
          required_licence_code?: string | null;
          transmission?: string | null;
          updated_at?: string;
          variant?: string | null;
          vehicle_category: string;
          vin?: string | null;
        };
        Update: {
          administrative_status?: string;
          archived_at?: string | null;
          company_id?: string;
          created_at?: string;
          current_branch_id?: string;
          current_odometer_km?: number;
          current_odometer_reading_id?: string | null;
          department_id?: string | null;
          engine_number?: string | null;
          fleet_number?: string;
          fuel_type?: string | null;
          id?: string;
          make?: string;
          model?: string;
          model_year?: number | null;
          registration_number?: string;
          required_licence_code?: string | null;
          transmission?: string | null;
          updated_at?: string;
          variant?: string | null;
          vehicle_category?: string;
          vin?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vehicles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicles_current_branch_id_company_id_fkey";
            columns: ["current_branch_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id", "company_id"];
          },
          {
            foreignKeyName: "vehicles_department_id_company_id_fkey";
            columns: ["department_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id", "company_id"];
          },
        ];
      };
    };
    Views: {
      driver_licences_safe: {
        Row: {
          branch_id: string | null;
          company_id: string | null;
          created_at: string | null;
          driver_id: string | null;
          expiry_date: string | null;
          has_evidence: boolean | null;
          id: string | null;
          issue_date: string | null;
          licence_code: string | null;
          prdp_expiry_date: string | null;
          prdp_required: boolean | null;
          verification_status: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      driver_register: {
        Row: {
          active_status: string | null;
          branch_id: string | null;
          company_id: string | null;
          display_name: string | null;
          employee_number: string | null;
          id: string | null;
          licence_expiry_date: string | null;
          licence_verification_status: string | null;
          phone: string | null;
          pin_change_pending: boolean | null;
          prdp_expiry_date: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      vehicle_service_status: {
        Row: {
          awaiting_verification: boolean | null;
          baseline_required: boolean | null;
          early_tolerance_days: number | null;
          early_tolerance_km: number | null;
          early_warning_date: string | null;
          early_warning_odometer_km: number | null;
          last_verified_service_date: string | null;
          last_verified_service_odometer_km: number | null;
          last_verified_service_record_id: string | null;
          late_tolerance_date: string | null;
          late_tolerance_days: number | null;
          late_tolerance_km: number | null;
          late_tolerance_odometer_km: number | null;
          next_service_odometer_km: number | null;
          service_config_id: string | null;
          service_config_scope: string | null;
          service_due_date: string | null;
          service_interval_days: number | null;
          service_interval_km: number | null;
          vehicle_id: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
    };
    Functions: {
      access_cleared: { Args: { p_user: string }; Returns: boolean };
      admin_create_driver: {
        Args: {
          p_actor: string;
          p_branch_id: string;
          p_display_name: string;
          p_employee_number: string;
          p_login_identifier: string;
          p_phone?: string;
          p_user_id: string;
        };
        Returns: string;
      };
      admin_create_staff: {
        Args: {
          p_actor: string;
          p_display_name: string;
          p_email: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      allocation_closure_blockers: {
        Args: { p_allocation_id: string };
        Returns: string[];
      };
      allocation_create_row: {
        Args: {
          p_actor: string;
          p_approval: string;
          p_branch: string;
          p_check: string;
          p_company: string;
          p_created_by: string;
          p_csid: string;
          p_driver: string;
          p_end: string;
          p_id: string;
          p_metadata: Json;
          p_reason: string;
          p_shift: string;
          p_start: string;
          p_vehicle: string;
        };
        Returns: string;
      };
      allocation_eligibility: {
        Args: {
          p_driver_id: string;
          p_planned_end_at: string;
          p_planned_start_at: string;
          p_shift_id: string;
          p_vehicle_id: string;
        };
        Returns: {
          block_reasons: string[];
          licence_class_check: string;
          needs_override: boolean;
          ok: boolean;
        }[];
      };
      allocation_eligibility_core: {
        Args: {
          p_company: string;
          p_driver_id: string;
          p_end: string;
          p_exclude_allocation_id?: string;
          p_shift_id: string;
          p_start: string;
          p_vehicle_id: string;
        };
        Returns: {
          r_branch: string;
          r_check: string;
          r_end: string;
          r_needs_override: boolean;
          r_ok: boolean;
          r_reasons: string[];
          r_start: string;
        }[];
      };
      allocation_fail: {
        Args: { p_detail?: string; p_message: string; p_sqlstate: string };
        Returns: undefined;
      };
      allocation_no_show_allowed: {
        Args: {
          p_grace_minutes: number;
          p_now: string;
          p_planned_start: string;
        };
        Returns: boolean;
      };
      allocation_refusal: { Args: { p_reasons: string[] }; Returns: undefined };
      allocation_settings: {
        Args: { p_company_id: string };
        Returns: {
          no_show_grace_minutes: number;
          open_before_start_minutes: number;
        }[];
      };
      allocation_start_blockers: {
        Args: { p_allocation_id: string; p_now: string };
        Returns: string[];
      };
      allocation_start_window_open: {
        Args: {
          p_now: string;
          p_open_before_minutes: number;
          p_planned_end: string;
          p_planned_start: string;
        };
        Returns: boolean;
      };
      allocation_transition_allowed: {
        Args: { p_from: string; p_to: string };
        Returns: boolean;
      };
      amend_allocation_times: {
        Args: {
          p_allocation_id: string;
          p_client_submission_id: string;
          p_planned_end_at: string;
          p_planned_start_at: string;
          p_reason: string;
        };
        Returns: {
          out_allocation_id: string;
          out_planned_end_at: string;
          out_planned_start_at: string;
          out_replayed: boolean;
        }[];
      };
      amend_eligibility: {
        Args: {
          p_allocation_id: string;
          p_planned_end_at: string;
          p_planned_start_at: string;
        };
        Returns: { block_reasons: string[]; ok: boolean }[];
      };
      apply_approved_effect: {
        Args: { p_approval_id: string };
        Returns: undefined;
      };
      apply_branch_transfer: {
        Args: { p_approval_id: string };
        Returns: undefined;
      };
      apply_licence_override: {
        Args: { p_approval_id: string };
        Returns: undefined;
      };
      apply_service_config_override: {
        Args: { p_approval_id: string };
        Returns: undefined;
      };
      approval_decide_permission: { Args: { p_type: string }; Returns: string };
      archive_shift_template: {
        Args: { p_reason: string; p_template_id: string };
        Returns: undefined;
      };
      attach_import_row_evidence: {
        Args: {
          p_client_submission_id: string;
          p_evidence_file_id: string;
          p_row_id: string;
        };
        Returns: string;
      };
      auth_complete_password_change: {
        Args: { p_profile: string };
        Returns: undefined;
      };
      auth_complete_pin_change: {
        Args: { p_profile: string };
        Returns: undefined;
      };
      auth_issue_pin_flags: {
        Args: { p_actor: string; p_mode: string; p_target: string };
        Returns: undefined;
      };
      auth_issue_staff_password_flags: {
        Args: { p_actor: string; p_target: string };
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
      authorise_staff_password_change: {
        Args: { p_actor: string; p_user: string };
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
      can_view_licence: {
        Args: { p_branch_id: string; p_driver_profile_id: string };
        Returns: boolean;
      };
      cancel_approval: {
        Args: { p_approval_id: string };
        Returns: {
          approval_type: string;
          assigned_approver: string | null;
          branch_id: string | null;
          client_submission_id: string | null;
          company_id: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_notes: string | null;
          entity_id: string;
          entity_type: string;
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
          requested_by: string;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "approvals";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      cancel_shift: {
        Args: { p_reason: string; p_shift_id: string };
        Returns: undefined;
      };
      change_company_default_service_config: {
        Args: {
          p_early_days: number;
          p_early_km: number;
          p_interval_days: number;
          p_interval_km: number;
          p_late_days: number;
          p_late_km: number;
          p_manufacturer_reference: string;
          p_reason: string;
        };
        Returns: {
          approval_id: string | null;
          approved_by: string | null;
          company_id: string;
          created_at: string;
          created_by: string | null;
          early_tolerance_days: number | null;
          early_tolerance_km: number;
          effective_from: string;
          effective_to: string | null;
          id: string;
          late_tolerance_days: number | null;
          late_tolerance_km: number;
          make: string | null;
          manufacturer_reference: string | null;
          model: string | null;
          reason: string;
          scope: string;
          service_interval_days: number | null;
          service_interval_km: number;
          vehicle_category: string | null;
          vehicle_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "vehicle_service_configs";
          isOneToOne: true;
          isSetofReturn: false;
        };
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
      create_service_record: {
        Args: {
          p_client_submission_id: string;
          p_evidence_file_id: string;
          p_invoice_reference: string;
          p_job_reference: string;
          p_labour_cost: number;
          p_odometer_km: number;
          p_parts_cost: number;
          p_service_date: string;
          p_service_type: string;
          p_source: string;
          p_supplier_name: string;
          p_total_cost: number;
          p_vehicle_id: string;
        };
        Returns: string;
      };
      create_shift: {
        Args: {
          p_branch_id: string;
          p_client_submission_id: string;
          p_department_id: string;
          p_end_time: string;
          p_shift_date: string;
          p_start_time: string;
        };
        Returns: string;
      };
      create_shift_template: {
        Args: {
          p_branch_id: string;
          p_end_time: string;
          p_name: string;
          p_start_time: string;
        };
        Returns: string;
      };
      create_vehicle: {
        Args: {
          p_administrative_status?: string;
          p_branch_id: string;
          p_department_id?: string;
          p_engine_number?: string;
          p_fleet_number: string;
          p_fuel_type?: string;
          p_make: string;
          p_model: string;
          p_model_year?: number;
          p_registration_number: string;
          p_transmission?: string;
          p_variant?: string;
          p_vehicle_category: string;
          p_vin?: string;
        };
        Returns: {
          administrative_status: string;
          archived_at: string | null;
          company_id: string;
          created_at: string;
          current_branch_id: string;
          current_odometer_km: number;
          current_odometer_reading_id: string | null;
          department_id: string | null;
          engine_number: string | null;
          fleet_number: string;
          fuel_type: string | null;
          id: string;
          make: string;
          model: string;
          model_year: number | null;
          registration_number: string;
          required_licence_code: string | null;
          transmission: string | null;
          updated_at: string;
          variant: string | null;
          vehicle_category: string;
          vin: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "vehicles";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      current_company_id: { Args: Record<PropertyKey, never>; Returns: string };
      current_user_requires_mfa: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      decide_approval: {
        Args: { p_approval_id: string; p_decision: string; p_notes?: string };
        Returns: {
          approval_type: string;
          assigned_approver: string | null;
          branch_id: string | null;
          client_submission_id: string | null;
          company_id: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_notes: string | null;
          entity_id: string;
          entity_type: string;
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
          requested_by: string;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "approvals";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      driver_is_self: { Args: { p_driver_id: string }; Returns: boolean };
      driver_licences_safe_rows: {
        Args: Record<PropertyKey, never>;
        Returns: {
          branch_id: string;
          company_id: string;
          created_at: string;
          driver_id: string;
          expiry_date: string;
          has_evidence: boolean;
          id: string;
          issue_date: string;
          licence_code: string;
          prdp_expiry_date: string;
          prdp_required: boolean;
          verification_status: string;
        }[];
      };
      driver_register_rows: {
        Args: Record<PropertyKey, never>;
        Returns: {
          active_status: string;
          branch_id: string;
          company_id: string;
          display_name: string;
          employee_number: string;
          id: string;
          licence_expiry_date: string;
          licence_verification_status: string;
          phone: string;
          pin_change_pending: boolean;
          prdp_expiry_date: string;
        }[];
      };
      driver_register_visible: {
        Args: { p_branch_id: string; p_profile_id: string };
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
      generate_shifts: {
        Args: {
          p_client_submission_id: string;
          p_from: string;
          p_template_id: string;
          p_to: string;
        };
        Returns: {
          created: number;
          skipped: number;
        }[];
      };
      has_branch_access: { Args: { p_branch_id: string }; Returns: boolean };
      has_permission: {
        Args: { permission_key: string; target_branch_id: string };
        Returns: boolean;
      };
      is_staff_member: { Args: Record<PropertyKey, never>; Returns: boolean };
      issue_evidence_access: {
        Args: {
          p_evidence_file_id: string;
          p_purpose?: string;
          p_related_entity_id?: string;
          p_related_entity_type?: string;
          p_ttl_seconds?: number;
        };
        Returns: {
          bucket: string;
          object_path: string;
        }[];
      };
      licence_code_coverage: {
        Args: { p_held: string; p_required: string };
        Returns: boolean;
      };
      licence_evidence_owner_allows: {
        Args: { p_file_id: string };
        Returns: boolean;
      };
      my_allocations: {
        Args: { p_from: string; p_to: string };
        Returns: {
          allocation_id: string;
          branch_name: string;
          can_open: boolean;
          licence_class_check: string;
          opened_on_behalf: boolean;
          planned_end_at: string;
          planned_start_at: string;
          shift_date: string;
          shift_end_at: string;
          shift_start_at: string;
          status: string;
          vehicle_fleet_number: string;
          vehicle_make: string;
          vehicle_model: string;
          vehicle_registration: string;
        }[];
      };
      mark_evidence_slots_object_removed: {
        Args: { p_ids: string[] };
        Returns: number;
      };
      record_driver_licence: {
        Args: {
          p_client_submission_id: string;
          p_driver_id: string;
          p_evidence_file_id: string;
          p_expiry_date: string;
          p_issue_date: string;
          p_licence_code: string;
          p_licence_number: string;
          p_prdp_expiry_date: string;
          p_prdp_required: boolean;
        };
        Returns: string;
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
      release_allocation: {
        Args: {
          p_allocation_id: string;
          p_client_submission_id: string;
          p_reason: string;
        };
        Returns: undefined;
      };
      request_allocation: {
        Args: {
          p_client_submission_id: string;
          p_driver_id: string;
          p_planned_end_at: string;
          p_planned_start_at: string;
          p_reason: string;
          p_shift_id: string;
          p_vehicle_id: string;
        };
        Returns: {
          allocation_id: string;
          approval_id: string;
        }[];
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
      request_service_config_override: {
        Args: {
          p_client_submission_id: string;
          p_early_days: number;
          p_early_km: number;
          p_interval_days: number;
          p_interval_km: number;
          p_late_days: number;
          p_late_km: number;
          p_make: string;
          p_manufacturer_reference: string;
          p_model: string;
          p_reason: string;
          p_scope: string;
          p_vehicle_category: string;
          p_vehicle_id: string;
        };
        Returns: {
          approval_type: string;
          assigned_approver: string | null;
          branch_id: string | null;
          client_submission_id: string | null;
          company_id: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_notes: string | null;
          entity_id: string;
          entity_type: string;
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
          requested_by: string;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "approvals";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      request_vehicle_transfer: {
        Args: {
          p_client_submission_id: string;
          p_reason: string;
          p_to_branch_id: string;
          p_vehicle_id: string;
        };
        Returns: {
          approval_type: string;
          assigned_approver: string | null;
          branch_id: string | null;
          client_submission_id: string | null;
          company_id: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_notes: string | null;
          entity_id: string;
          entity_type: string;
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
          requested_by: string;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "approvals";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      resolve_service_config: {
        Args: { p_at?: string; p_vehicle_id: string };
        Returns: {
          approval_id: string | null;
          approved_by: string | null;
          company_id: string;
          created_at: string;
          created_by: string | null;
          early_tolerance_days: number | null;
          early_tolerance_km: number;
          effective_from: string;
          effective_to: string | null;
          id: string;
          late_tolerance_days: number | null;
          late_tolerance_km: number;
          make: string | null;
          manufacturer_reference: string | null;
          model: string | null;
          reason: string;
          scope: string;
          service_interval_days: number | null;
          service_interval_km: number;
          vehicle_category: string | null;
          vehicle_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "vehicle_service_configs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reverse_service_verification: {
        Args: { p_reason: string; p_record_id: string };
        Returns: undefined;
      };
      service_config_lookup: {
        Args: { p_at: string; p_vehicle_id: string };
        Returns: {
          approval_id: string | null;
          approved_by: string | null;
          company_id: string;
          created_at: string;
          created_by: string | null;
          early_tolerance_days: number | null;
          early_tolerance_km: number;
          effective_from: string;
          effective_to: string | null;
          id: string;
          late_tolerance_days: number | null;
          late_tolerance_km: number;
          make: string | null;
          manufacturer_reference: string | null;
          model: string | null;
          reason: string;
          scope: string;
          service_interval_days: number | null;
          service_interval_km: number;
          vehicle_category: string | null;
          vehicle_id: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "vehicle_service_configs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      service_config_validate: {
        Args: {
          p_category: string;
          p_early_days: number;
          p_early_km: number;
          p_interval_days: number;
          p_interval_km: number;
          p_late_days: number;
          p_late_km: number;
          p_make: string;
          p_model: string;
          p_scope: string;
          p_vehicle_id: string;
        };
        Returns: undefined;
      };
      service_record_insert: {
        Args: {
          p_client_submission_id: string;
          p_company_id: string;
          p_evidence_file_id: string;
          p_invoice_reference: string;
          p_job_reference: string;
          p_labour_cost: number;
          p_odometer_km: number;
          p_parts_cost: number;
          p_service_date: string;
          p_service_type: string;
          p_source: string;
          p_supplier_name: string;
          p_total_cost: number;
          p_user: string;
          p_vehicle_id: string;
        };
        Returns: string;
      };
      set_driver_status: {
        Args: { p_driver_id: string; p_reason: string; p_status: string };
        Returns: undefined;
      };
      set_vehicle_required_licence_code: {
        Args: { p_code: string; p_reason: string; p_vehicle_id: string };
        Returns: undefined;
      };
      shift_access: {
        Args: Record<PropertyKey, never>;
        Returns: {
          branch_id: string;
          branch_name: string;
          can_manage: boolean;
          can_view: boolean;
        }[];
      };
      shift_has_active_allocations: {
        Args: { p_shift_id: string };
        Returns: boolean;
      };
      shift_times: {
        Args: { p_date: string; p_end: string; p_start: string };
        Returns: {
          scheduled_end_at: string;
          scheduled_start_at: string;
        }[];
      };
      stage_service_import: {
        Args: {
          p_client_submission_id: string;
          p_filename: string;
          p_rows: Json;
        };
        Returns: string;
      };
      transition_allocation: {
        Args: {
          p_allocation_id: string;
          p_client_submission_id: string;
          p_reason: string;
          p_to_status: string;
        };
        Returns: {
          out_allocation_id: string;
          out_replayed: boolean;
          out_status: string;
        }[];
      };
      update_driver_details: {
        Args: { p_display_name: string; p_driver_id: string; p_phone?: string };
        Returns: undefined;
      };
      update_shift_template: {
        Args: {
          p_end_time: string;
          p_name: string;
          p_start_time: string;
          p_template_id: string;
        };
        Returns: undefined;
      };
      user_has_permission: {
        Args: { p_branch_id: string; p_permission_key: string; p_user: string };
        Returns: boolean;
      };
      user_requires_mfa: { Args: { p_user: string }; Returns: boolean };
      vehicle_service_status_rows: {
        Args: Record<PropertyKey, never>;
        Returns: {
          awaiting_verification: boolean;
          baseline_required: boolean;
          early_tolerance_days: number;
          early_tolerance_km: number;
          early_warning_date: string;
          early_warning_odometer_km: number;
          last_verified_service_date: string;
          last_verified_service_odometer_km: number;
          last_verified_service_record_id: string;
          late_tolerance_date: string;
          late_tolerance_days: number;
          late_tolerance_km: number;
          late_tolerance_odometer_km: number;
          next_service_odometer_km: number;
          service_config_id: string;
          service_config_scope: string;
          service_due_date: string;
          service_interval_days: number;
          service_interval_km: number;
          vehicle_id: string;
        }[];
      };
      verify_driver_licence: {
        Args: { p_decision: string; p_licence_id: string; p_reason?: string };
        Returns: undefined;
      };
      verify_service_record: {
        Args: { p_decision: string; p_reason?: string; p_record_id: string };
        Returns: undefined;
      };
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
