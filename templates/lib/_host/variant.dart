// The UI variant interface. Every variant is a Variant subclass in lib/variants/,
// registered in lib/registry.dart.
import 'package:flutter/widgets.dart';

/// The variant category: layout, colors or a widget look.
enum VariantCategory {
  layout('Layout'),
  color('Colors'),
  widget('Widget');

  const VariantCategory(this.label);

  /// The group label.
  final String label;
}

/// One UI variant shown in the picker window.
abstract class Variant {
  const Variant();

  /// A unique id, for example `login-compact`.
  String get id;

  /// A short title, in the conversation language.
  String get title;

  /// The variant category.
  VariantCategory get category;

  /// The feature the variant belongs to (one per show), for example "Sign-in screen".
  String get feature;

  /// A short description under the title (optional).
  String get description => '';

  /// The question in which one variant is chosen; the category by default.
  /// If a show has several independent things to choose (layout and color,
  /// different elements), each gets its own group, for example "Sign-in button",
  /// and the window asks for one variant in each.
  String get group => category.label;

  /// A whole screen (true) or a component that the window centers.
  bool get isFullScreen => category == VariantCategory.layout;

  /// The variant itself. Built inside a MaterialApp with the project theme and the preview size.
  Widget build(BuildContext context);
}
