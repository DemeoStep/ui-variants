// Точка входа окна-пикера вариантов UI. Файл обновляется модом ui-variants.
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
