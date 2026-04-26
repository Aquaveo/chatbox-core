/**
 * chatTheme.js — Design tokens for the chatbox UI.
 * Used by styled-components ThemeProvider.
 */

const chatTheme = {
  colors: {
    primary: "#1f7db8",
    primaryHover: "#17699d",
    primaryLight: "rgba(31, 125, 184, 0.08)",
    primaryBgLight: "rgba(31, 125, 184, 0.1)",

    userBubble: "#d9ecff",
    assistantBubble: "#f0f2f5",

    surface: "#ffffff",
    surfaceAlt: "#f4f6f8",
    surfaceInput: "#f4f6f8",

    text: "#1a2b3c",
    textMuted: "#5a6a78",
    textStatus: "#4e6573",

    border: "#b7c7d1",
    borderLight: "#c8d8e2",
    borderHover: "#e4edf3",

    avatarUser: "#1f7db8",
    avatarBot: "#6b7b8d",

    error: "#d03f3f",
    errorHover: "#b83232",
    errorBg: "#fff0f0",
    errorText: "#7d1d1d",

    thinking: "#fff7e8",
    thinkingBorder: "#d4bb8f",
    thinkingBorderInner: "#e8d5b0",
    thinkingText: "#8a6d3b",
    thinkingTextHover: "#6b5230",

    sendDisabled: "#c2d3de",

    chatLogBg: "linear-gradient(145deg, #f7fbff, #ecf5fb)",
  },

  spacing: {
    xs: "0.25rem",
    sm: "0.4rem",
    md: "0.5rem",
    lg: "0.75rem",
    xl: "1rem",
    xxl: "1.5rem",
  },

  fontSize: {
    sm: "0.82rem",
    base: "0.92rem",
    md: "0.96rem",
    lg: "1rem",
    xl: "1.5rem",
  },

  radius: {
    sm: "8px",
    md: "12px",
    lg: "14px",
    xl: "18px",
    full: "999px",
    circle: "50%",
  },

  sizes: {
    avatar: "32px",
    sendButton: "34px",
    welcomeLogo: "56px",
    maxInputWidth: "700px",
  },
};

export default chatTheme;
