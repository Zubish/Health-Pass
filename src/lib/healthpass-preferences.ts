import { createContext, useContext } from "react";
export type Preferences = { theme: "system" | "light" | "dark"; soundEnabled: boolean };
export const defaults: Preferences = { theme: "system", soundEnabled: true };
export const FeedbackContext = createContext<{
  preferences: Preferences;
  success: (message: string) => void;
}>({ preferences: defaults, success: () => {} });
export const useSuccessFeedback = () => useContext(FeedbackContext).success;
export const usePreferences = () => useContext(FeedbackContext).preferences;
