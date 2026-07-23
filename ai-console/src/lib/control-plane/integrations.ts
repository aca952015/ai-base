export type EnterpriseIntegrationPlatform = "feishu" | "wecom" | "dingtalk";

export type IntegrationApplication = {
  id: string;
  platform: EnterpriseIntegrationPlatform;
  name: string;
  appId: string;
  note: string;
  secretConfigured: true;
  createdAt: string;
  updatedAt: string;
};

export type EnterpriseIntegrationGroup = {
  platform: EnterpriseIntegrationPlatform;
  displayName: string;
  description: string;
  applications: IntegrationApplication[];
};

export type EnterpriseIntegrationsSnapshot = {
  groups: EnterpriseIntegrationGroup[];
  updatedAt: string;
};
