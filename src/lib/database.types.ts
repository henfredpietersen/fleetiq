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
      current_company_id: { Args: Record<PropertyKey, never>; Returns: string };
      current_user_requires_mfa: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      has_permission: {
        Args: { permission_key: string; target_branch_id: string };
        Returns: boolean;
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
