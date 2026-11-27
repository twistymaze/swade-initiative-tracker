import { Theme as MuiTheme, createTheme, ThemeProvider } from "@mui/material/styles";
import { CssBaseline } from "@mui/material";
import OBR, { Theme } from "@owlbear-rodeo/sdk";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Create a MUI theme based off of the current OBR theme
 */
function getTheme(theme?: Theme) {
  return createTheme({
    palette: theme
      ? {
          mode: theme.mode === "LIGHT" ? "light" : "dark",
          text: theme.text,
          primary: theme.primary,
          secondary: theme.secondary,
          background: theme?.background,
        }
      : undefined,
    shape: {
      borderRadius: 16,
    },
    components: {
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
      },
      MuiCssBaseline: {
        styleOverrides: theme ? {
          body: {
            color: theme.text.primary,
          },
        } : undefined,
      },
    },
  });
}

/**
 * Provide a MUI theme with the same palette as the parent OBR window
 */
export function PluginThemeProvider({
  children,
}: {
  children?: ReactNode;
}) {
  const [theme, setTheme] = useState<MuiTheme>(() => getTheme());
  useEffect(() => {
    const updateTheme = (theme: Theme) => {
      setTheme(getTheme(theme));
    };
    OBR.theme
      .getTheme()
      .then(updateTheme)
      .catch((error) => console.error("[SWADE] Failed to read the OBR theme", error));
    return OBR.theme.onChange(updateTheme);
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
