// Интерфейс варианта UI. Каждый вариант — подкласс Variant в lib/variants/,
// зарегистрированный в lib/registry.dart.
import 'package:flutter/widgets.dart';

/// Категория варианта: раскладка, цвета или вид виджета.
enum VariantCategory {
  layout('Раскладка'),
  color('Цвета'),
  widget('Вид виджета');

  const VariantCategory(this.label);

  /// Подпись группы в списке вариантов.
  final String label;
}

/// Один вариант UI для показа в окне-пикере.
abstract class Variant {
  const Variant();

  /// Уникальный id латиницей, например `login-compact`.
  String get id;

  /// Название в списке, по-русски.
  String get title;

  /// Категория варианта.
  VariantCategory get category;

  /// Фича, к которой относится вариант (одна на весь показ), например «Экран входа».
  String get feature;

  /// Короткое пояснение под названием (необязательно).
  String get description => '';

  /// Вопрос, в котором выбирается один вариант; по умолчанию — категория.
  /// Если в показе несколько независимых пунктов (раскладка и цвет, разные
  /// элементы), у каждого пункта своя группа, например «Кнопка входа», и окно
  /// попросит выбрать по варианту в каждой.
  String get group => category.label;

  /// Экран целиком (true) или отдельный компонент, который окно покажет по центру.
  bool get isFullScreen => category == VariantCategory.layout;

  /// Сам вариант. Строится внутри MaterialApp с темой проекта и размером предпросмотра.
  Widget build(BuildContext context);
}
