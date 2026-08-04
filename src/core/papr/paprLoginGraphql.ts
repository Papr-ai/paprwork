/** GraphQL documents for Papr login provisioning (shared + testable). */

export const GET_NAMESPACE_API_KEYS = `
  query GetNamespaceApiKeys($namespaceId: ID!) {
    aPIKeys(where: { namespace: { have: { objectId: { equalTo: $namespaceId } } }, is_active: { equalTo: true } }) {
      edges {
        node {
          objectId
          key
        }
      }
    }
  }
`;

export const UPDATE_WORKSPACE_ORG = `
  mutation UpdateWorkspaceOrganization(
    $workspaceId: ID!,
    $organizationId: ID!
  ) {
    updateWorkSpace(
      input: {
        id: $workspaceId
        fields: {
          organization: { link: $organizationId }
        }
      }
    ) {
      workSpace {
        objectId
      }
    }
  }
`;

/** Guard against regressions like workspace vs workSpace on UpdateWorkSpacePayload. */
export function assertUpdateWorkspaceOrgMutation(mutation: string): void {
  if (!mutation.includes("updateWorkSpace(")) {
    throw new Error("UPDATE_WORKSPACE_ORG must call updateWorkSpace");
  }
  if (!/workSpace\s*\{/.test(mutation)) {
    throw new Error('UPDATE_WORKSPACE_ORG must select workSpace { ... } on the payload');
  }
  if (/updateWorkSpace[\s\S]*\bworkspace\s*\{/.test(mutation)) {
    throw new Error(
      'UPDATE_WORKSPACE_ORG must not select workspace { ... } — use workSpace per Parse schema',
    );
  }
}
