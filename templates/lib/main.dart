// Entry point of the UI variants picker window. Updated by the ui-variants mod.
import 'package:flutter/widgets.dart';

import '_host/picker.dart';
import 'registry.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    PickerApp(
      variants: variants,
      theme: previewTheme,
      darkTheme: previewDarkTheme,
      localizationsDelegates: previewLocalizationsDelegates,
      supportedLocales: previewSupportedLocales,
      wrap: wrapPreview,
      stateDir: const String.fromEnvironment('UI_VARIANTS_STATE'),
      package: const String.fromEnvironment('UI_VARIANTS_PACKAGE'),
    ),
  );
}
