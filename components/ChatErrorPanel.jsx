import styled from "styled-components";

const ErrorSection = styled.section`
  border: 1px solid ${({ theme }) => theme.colors.error};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: ${({ theme }) => `${theme.spacing.lg} 0.85rem`};
  background: ${({ theme }) => theme.colors.errorBg};
  color: ${({ theme }) => theme.colors.errorText};
`;

export default function ChatErrorPanel({ error }) {
  if (!error) return null;
  return (
    <ErrorSection role="alert" aria-live="assertive">
      <strong>Error:</strong> {error}
    </ErrorSection>
  );
}
