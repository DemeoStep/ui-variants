// Окно-пикер: варианты текущего вопроса рядом, каждый в рамке выбранного
// устройства; вопросы — чипы сверху; внизу общий комментарий и отправка.
import 'dart:async';
import 'dart:io' show exit;

import 'package:flutter/material.dart';

import 'decision.dart';
import 'frames.dart';
import 'variant.dart';
import 'version.dart';
import 'window.dart';

typedef PreviewThemeBuilder = ThemeData Function();
typedef PreviewWrapper = Widget Function(BuildContext context, Widget child);

/// Значение выбора устройства «без рамки, по размеру карточки».
const String _freeSize = 'free';

/// Сколько вариантов помещается рядом; больше — прокрутка вбок.
const int _maxSideBySide = 4;

/// Приложение окна-пикера.
class PickerApp extends StatelessWidget {
  const PickerApp({
    super.key,
    required this.variants,
    required this.theme,
    required this.darkTheme,
    required this.localizationsDelegates,
    required this.supportedLocales,
    required this.wrap,
    required this.stateDir,
    required this.package,
  });

  final List<Variant> variants;
  final PreviewThemeBuilder theme;
  final PreviewThemeBuilder darkTheme;
  final List<LocalizationsDelegate<dynamic>> localizationsDelegates;
  final List<Locale> supportedLocales;
  final PreviewWrapper wrap;
  final String stateDir;
  final String package;

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF55657F);
    return MaterialApp(
      title: 'Варианты UI',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: seed),
      darkTheme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: seed,
        brightness: Brightness.dark,
      ),
      home: PickerScreen(app: this),
    );
  }
}

/// Экран выбора вариантов.
class PickerScreen extends StatefulWidget {
  const PickerScreen({super.key, required this.app});

  final PickerApp app;

  @override
  State<PickerScreen> createState() => _PickerScreenState();
}

class _PickerScreenState extends State<PickerScreen> {
  late final DecisionFile _file = DecisionFile(widget.app.stateDir);
  late Decision _decision;
  late final List<PreviewDevice> _devices = previewDevices();
  final TextEditingController _comment = TextEditingController();

  /// Открытый вопрос.
  String _group = '';

  /// Устройство предпросмотра или [_freeSize].
  String _deviceId = _freeSize;
  bool _isLandscape = false;
  bool _isDark = false;
  String _status = '';

  /// Ответ мода на последний выбор: null — ждём, `waiting` — долго нет ответа.
  String? _ackStatus;
  Timer? _ackTimer;

  /// Отметки последней отправки: те же повторно не отправляются.
  String? _sentMarks;

  /// Сторож: окно закрывается само, если сессия Claude пропала без session.end.
  Timer? _watchdog;
  int _staleChecks = 0;

  /// Запуск окна (и каждый hot restart): правки до него уже учтены в вариантах.
  final DateTime _startedAt = DateTime.now();

  /// Правки, которые мод уже отправил Claude.
  Set<String> _sentRequests = <String>{};
  Timer? _requestTimer;

  List<Variant> get _variants => widget.app.variants;

  /// Вопросы показа в порядке появления вариантов.
  List<String> get _groups {
    final groups = <String>[];
    for (final variant in _variants) {
      if (!groups.contains(variant.group)) groups.add(variant.group);
    }
    return groups;
  }

  /// Несколько вопросов: вариант отмечается в каждом, затем всё отправляется
  /// одним сообщением. Один вопрос: «Выбрать» сразу отправляет выбор.
  bool get _isMulti => _groups.length > 1;

  Choice? _choiceIn(String group) {
    for (final choice in _decision.choices) {
      if (choice.group == group) return choice;
    }
    return null;
  }

  bool _isPicked(Variant variant) => _isMulti
      ? _choiceIn(variant.group)?.variantId == variant.id
      : _decision.chosen == variant.id;

  int get _markedCount =>
      _groups.where((group) => _choiceIn(group) != null).length;

  String _marksKey() => _decision.choices
      .map((choice) => '${choice.group}=${choice.variantId}')
      .join(';');

  /// Отправить можно, когда отмечено по варианту в каждом вопросе и эти
  /// отметки ещё не отправлялись.
  bool get _canSend =>
      _markedCount == _groups.length && _marksKey() != _sentMarks;

  PreviewDevice? get _device {
    for (final device in _devices) {
      if (device.id == _deviceId) return device;
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _decision = _loadDecision();
    final groups = _groups;
    _group = groups.firstWhere((group) => _choiceIn(group) == null,
        orElse: () => groups.isEmpty ? '' : groups.first);
    final view = _file.readView();
    final savedDevice = view['device'];
    _deviceId = savedDevice is String &&
            (savedDevice == _freeSize ||
                _devices.any((device) => device.id == savedDevice))
        ? savedDevice
        : defaultDeviceId();
    _isLandscape = view['landscape'] == true;
    _isDark = view['dark'] == true;
    if (!_file.isAvailable) {
      _status = 'Не задан UI_VARIANTS_STATE: выбор не будет передан Claude.';
    }
    _startWatchdog();
    bringWindowToFront();
  }

  /// Метку жизни мод пишет раз в 5 секунд. Окно закрывается, если метка старше
  /// минуты при двух проверках подряд: одна устаревшая проверка бывает сразу
  /// после сна Mac, пока мод ещё не обновил метку.
  void _startWatchdog() {
    _watchdog = Timer.periodic(const Duration(seconds: 15), (timer) {
      final at = _file.readHeartbeat();
      final isStale = at != null &&
          DateTime.now().difference(at) > const Duration(seconds: 60);
      _staleChecks = isStale ? _staleChecks + 1 : 0;
      if (_staleChecks >= 2) exit(0);
    });
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    _requestTimer?.cancel();
    _ackTimer?.cancel();
    _comment.dispose();
    super.dispose();
  }

  String _now() => DateTime.now().toUtc().toIso8601String();

  /// Решение из файла, если это тот же показ и выбор ещё не сделан
  /// (отметки и комментарии сохраняются); иначе — новый показ. Файл не
  /// трогается до первого действия.
  Decision _loadDecision() {
    final ids = _variants.map((variant) => variant.id).toList()..sort();
    final saved = _file.read();
    if (saved != null && saved.chosen == null) {
      final savedIds = List<String>.of(saved.variantIds)..sort();
      if (savedIds.join('\n') == ids.join('\n')) return saved;
    }
    final feature = _variants.isEmpty ? '' : _variants.first.feature;
    return Decision(round: _now(), feature: feature, variantIds: ids);
  }

  void _saveView() {
    _file.writeView(<String, Object?>{
      'device': _deviceId,
      'landscape': _isLandscape,
      'dark': _isDark,
    });
  }

  bool _save(String status) {
    if (!_file.isAvailable) {
      setState(() => _status =
          'Не задан UI_VARIANTS_STATE: решение не сохранено и не будет передано Claude.');
      return false;
    }
    try {
      _file.write(_decision);
      setState(() => _status = status);
      return true;
    } on Object catch (error) {
      setState(() => _status = 'Не удалось сохранить решение: $error');
      return false;
    }
  }

  /// Общий комментарий из нижнего поля уходит вместе с выбором.
  void _takeComment() {
    final text = _comment.text.trim();
    if (text.isEmpty) return;
    _decision.notes
        .add(Note(variantId: '', target: '', text: text, at: _now()));
    _comment.clear();
  }

  void _sortChoices() {
    final order = _groups;
    _decision.choices.sort(
        (a, b) => order.indexOf(a.group).compareTo(order.indexOf(b.group)));
  }

  /// Один вопрос: выбор варианта сразу отправляется Claude.
  void _choose(Variant variant) {
    _takeComment();
    _decision.choices
      ..clear()
      ..add(Choice(
          group: variant.group, variantId: variant.id, title: variant.title));
    _decision
      ..feature = variant.feature
      ..chosen = variant.id
      ..chosenTitle = variant.title
      ..chosenAt = _now();
    if (_save('')) _watchAck();
  }

  /// Несколько вопросов: отмечает вариант в его вопросе.
  void _mark(Variant variant) {
    _decision.feature = variant.feature;
    _decision.choices
      ..removeWhere((choice) => choice.group == variant.group)
      ..add(Choice(
          group: variant.group, variantId: variant.id, title: variant.title));
    _sortChoices();
    final left = _groups.where((group) => _choiceIn(group) == null).toList();
    _save(left.isEmpty
        ? 'Выбор сделан во всех вопросах. Нажмите «Отправить выбор».'
        : 'Отмечено. Осталось выбрать: ${left.join(', ')}.');
  }

  /// Несколько вопросов: отправляет Claude все отметки одним сообщением.
  void _send() {
    if (!_canSend) return;
    _takeComment();
    _sortChoices();
    final choices = _decision.choices;
    _decision
      ..chosen = choices.first.variantId
      ..chosenTitle = choices.map((choice) => choice.title).join(', ')
      ..chosenAt = _now();
    _sentMarks = _marksKey();
    if (_save('')) _watchAck();
  }

  /// Ждёт ack.json от мода для текущего выбора.
  void _watchAck() {
    _ackTimer?.cancel();
    _ackStatus = null;
    final chosenAt = _decision.chosenAt;
    final startedAt = DateTime.now();
    _ackTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      final ack = _file.readAck();
      if (ack != null && ack.chosenAt == chosenAt) {
        timer.cancel();
        setState(() => _ackStatus = ack.status);
        return;
      }
      final waited = DateTime.now().difference(startedAt);
      if (_ackStatus == null && waited > const Duration(seconds: 8)) {
        setState(() => _ackStatus = 'waiting');
      }
      if (waited > const Duration(minutes: 5)) timer.cancel();
    });
  }

  /// Правки варианта, отправленные после запуска окна: вариант ещё не обновлён.
  List<Request> _pendingRequests(Variant variant) => _decision.requests
      .where((request) =>
          request.variantId == variant.id &&
          (DateTime.tryParse(request.at)?.isAfter(_startedAt) ?? false))
      .toList();

  /// Следит, когда мод отправит новые правки Claude.
  void _watchRequests() {
    _requestTimer?.cancel();
    _requestTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      final sent = _file.readSentRequests();
      final isAllSent = _decision.requests
          .every((request) => sent.contains(request.id));
      setState(() => _sentRequests = sent);
      if (isAllSent) timer.cancel();
    });
  }

  Future<void> _editNote(Variant variant) async {
    final notes =
        _decision.notes.where((note) => note.variantId == variant.id).toList();
    final requests = _decision.requests
        .where((request) => request.variantId == variant.id)
        .toList();
    final result = await showDialog<_NoteResult>(
      context: context,
      builder: (context) =>
          _NoteDialog(variant: variant, notes: notes, requests: requests),
    );
    if (result == null) return;
    final at = DateTime.now().toUtc();
    if (!result.isRevision) {
      _decision.notes.add(Note(
          variantId: variant.id,
          target: result.target,
          text: result.text,
          at: at.toIso8601String()));
      _save('Заметка к «${variant.title}» сохранена. '
          'Claude получит её вместе с выбором.');
      return;
    }
    _decision.requests.add(Request(
      id: '${variant.id}-${at.microsecondsSinceEpoch}',
      variantId: variant.id,
      title: variant.title,
      target: result.target,
      text: result.text,
      at: at.toIso8601String(),
    ));
    if (_save('Правка «${variant.title}» отправлена Claude. '
        'Окно обновится, когда вариант будет готов.')) {
      _watchRequests();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildTopBar(context),
          const Divider(height: 1),
          Expanded(
            child: _variants.isEmpty
                ? _buildEmpty(context)
                : _buildComparison(context),
          ),
          const Divider(height: 1),
          _buildBottomBar(context),
        ],
      ),
    );
  }

  Widget _buildEmpty(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Text(
        'Вариантов пока нет.\nClaude добавит их в lib/registry.dart, и окно обновится само.',
        textAlign: TextAlign.center,
        style: theme.textTheme.bodyLarge
            ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
      ),
    );
  }

  Widget _buildTopBar(BuildContext context) {
    final theme = Theme.of(context);
    final features = <String>{
      for (final variant in _variants)
        if (variant.feature.isNotEmpty) variant.feature,
    };
    final subtitle = <String>[
      if (widget.app.package.isNotEmpty) widget.app.package,
      'шаблоны $hostTemplateVersion',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      child: Row(
        children: <Widget>[
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(features.isEmpty ? 'Варианты UI' : features.join(', '),
                  style: theme.textTheme.titleMedium),
              Text(subtitle,
                  style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(width: 24),
          Expanded(
            child: _isMulti
                ? SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: <Widget>[
                        for (final group in _groups) ...<Widget>[
                          ChoiceChip(
                            avatar: _choiceIn(group) == null
                                ? null
                                : const Icon(Icons.check, size: 16),
                            label: Text(group),
                            selected: group == _group,
                            onSelected: (_) => setState(() => _group = group),
                          ),
                          const SizedBox(width: 8),
                        ],
                      ],
                    ),
                  )
                : const SizedBox.shrink(),
          ),
          _buildDeviceMenu(context),
          IconButton(
            tooltip: _isLandscape ? 'Портретная ориентация' : 'Альбомная ориентация',
            icon: const Icon(Icons.screen_rotation),
            onPressed: _deviceId == _freeSize
                ? null
                : () {
                    setState(() => _isLandscape = !_isLandscape);
                    _saveView();
                  },
          ),
          IconButton(
            tooltip: _isDark ? 'Светлая тема' : 'Тёмная тема',
            icon: Icon(_isDark ? Icons.light_mode : Icons.dark_mode),
            onPressed: () {
              setState(() => _isDark = !_isDark);
              _saveView();
            },
          ),
        ],
      ),
    );
  }

  Widget _buildDeviceMenu(BuildContext context) {
    final device = _device;
    return PopupMenuButton<String>(
      tooltip: 'Устройство предпросмотра',
      initialValue: _deviceId,
      constraints: const BoxConstraints(minWidth: 280, maxWidth: 380),
      onSelected: (value) {
        setState(() => _deviceId = value);
        _saveView();
      },
      itemBuilder: (context) => <PopupMenuEntry<String>>[
        const PopupMenuItem<String>(
          value: _freeSize,
          child: Text('Без рамки, по размеру карточки'),
        ),
        const PopupMenuDivider(),
        for (final item in _devices)
          PopupMenuItem<String>(
            value: item.id,
            child: Row(
              children: <Widget>[
                Icon(item.isTablet ? Icons.tablet_mac : Icons.smartphone,
                    size: 18),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(item.name,
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
              ],
            ),
          ),
      ],
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(device == null
                ? Icons.crop_free
                : (device.isTablet ? Icons.tablet_mac : Icons.smartphone)),
            const SizedBox(width: 8),
            Text(device?.name ?? 'Без рамки'),
            const Icon(Icons.arrow_drop_down),
          ],
        ),
      ),
    );
  }

  Widget _buildComparison(BuildContext context) {
    final theme = Theme.of(context);
    final group = _variants.where((variant) => variant.group == _group).toList();
    const gap = 16.0;
    return ColoredBox(
      color: theme.colorScheme.surfaceContainerHighest,
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (group.length <= _maxSideBySide) {
            return Padding(
              padding: const EdgeInsets.all(gap),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  for (var i = 0; i < group.length; i++) ...<Widget>[
                    if (i > 0) const SizedBox(width: gap),
                    Expanded(child: _buildCard(context, group[i])),
                  ],
                ],
              ),
            );
          }
          final width = (constraints.maxWidth - gap) / _maxSideBySide - gap;
          return ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(gap),
            itemCount: group.length,
            separatorBuilder: (context, index) => const SizedBox(width: gap),
            itemBuilder: (context, index) => SizedBox(
              width: width < 280 ? 280 : width,
              child: _buildCard(context, group[index]),
            ),
          );
        },
      ),
    );
  }

  Widget _buildCard(BuildContext context, Variant variant) {
    final theme = Theme.of(context);
    final isPicked = _isPicked(variant);
    final notes = _decision.notes
            .where((note) => note.variantId == variant.id)
            .length +
        _decision.requests
            .where((request) => request.variantId == variant.id)
            .length;
    final description =
        variant.description.isEmpty ? variant.id : variant.description;
    final pending = _pendingRequests(variant);
    final isSent = pending.isNotEmpty &&
        pending.every((request) => _sentRequests.contains(request.id));
    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isPicked
              ? theme.colorScheme.primary
              : theme.colorScheme.outlineVariant,
          width: isPicked ? 2 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (pending.isNotEmpty) ...<Widget>[
            const ClipRRect(
              borderRadius: BorderRadius.vertical(top: Radius.circular(11)),
              child: LinearProgressIndicator(minHeight: 3),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
              child: Text(
                isSent
                    ? 'Claude правит вариант: ${pending.last.text}'
                    : 'Отправляем правку Claude…',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.primary),
              ),
            ),
          ],
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(variant.title,
                    style: theme.textTheme.titleSmall,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis),
                Text(description,
                    style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: _buildPreview(context, variant),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                if (isPicked)
                  FilledButton.icon(
                    onPressed: null,
                    icon: const Icon(Icons.check),
                    label: const Text('Выбран'),
                  )
                else
                  OutlinedButton(
                    onPressed: () =>
                        _isMulti ? _mark(variant) : _choose(variant),
                    child: const Text('Выбрать'),
                  ),
                const SizedBox(width: 4),
                IconButton(
                  tooltip: 'Правка или заметка',
                  onPressed: () => _editNote(variant),
                  icon: Badge(
                    isLabelVisible: notes > 0,
                    label: Text('$notes'),
                    child: const Icon(Icons.chat_bubble_outline),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPreview(BuildContext context, Variant variant) {
    final device = _device;
    final key = ValueKey<String>(
        '${variant.id}-$_isDark-$_deviceId-$_isLandscape');
    if (device == null) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: _PreviewApp(
          key: key,
          app: widget.app,
          variant: variant,
          isDark: _isDark,
          isFree: true,
        ),
      );
    }
    return Center(
      child: deviceFrame(
        deviceId: device.id,
        isLandscape: _isLandscape,
        screen: _PreviewApp(
          key: key,
          app: widget.app,
          variant: variant,
          isDark: _isDark,
          isFree: false,
          platform: device.platform,
        ),
      ),
    );
  }

  /// Плашка о судьбе выбора: передан ли он Claude.
  Widget _buildChoiceBanner(BuildContext context) {
    final theme = Theme.of(context);
    final title = _decision.chosenTitle ?? _decision.chosen ?? '';
    final what =
        _decision.choices.length > 1 ? 'выбор ($title)' : 'выбор «$title»';
    final whatCapital = 'В${what.substring(1)}';
    String text;
    var isWarning = false;
    switch (_ackStatus) {
      case 'sent':
        text = 'Claude получил $what и реализует его в проекте. '
            'Окно сейчас закроется.';
        break;
      case 'duplicate':
        text = '$whatCapital уже отправлен Claude. Окно сейчас закроется.';
        break;
      case 'waiting':
        text = '$whatCapital сохранён, но Claude пока не ответил. '
            'Проверьте, что сессия Claude в этом проекте открыта.';
        isWarning = true;
        break;
      default:
        text = '$whatCapital сохранён, передаём Claude…';
    }
    final background = isWarning
        ? theme.colorScheme.errorContainer
        : theme.colorScheme.primaryContainer;
    final foreground = isWarning
        ? theme.colorScheme.onErrorContainer
        : theme.colorScheme.onPrimaryContainer;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: <Widget>[
          Icon(
            _ackStatus == null
                ? Icons.hourglass_top
                : (isWarning ? Icons.warning_amber : Icons.check_circle),
            color: foreground,
            size: 20,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text,
                style: theme.textTheme.bodyMedium?.copyWith(color: foreground)),
          ),
        ],
      ),
    );
  }

  Widget _buildBottomBar(BuildContext context) {
    final theme = Theme.of(context);
    final hint = _isMulti
        ? 'Отметьте вариант в каждом вопросе и нажмите «Отправить выбор».'
        : 'Нажмите «Выбрать» под вариантом — выбор сразу уйдёт Claude.';
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (_decision.chosen != null) ...<Widget>[
            _buildChoiceBanner(context),
            const SizedBox(height: 10),
          ],
          Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  controller: _comment,
                  decoration: const InputDecoration(
                    hintText: 'Общий комментарий (необязательно)',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              if (_isMulti) ...<Widget>[
                const SizedBox(width: 12),
                Text('Выбрано $_markedCount из ${_groups.length}',
                    style: theme.textTheme.bodyMedium),
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: _canSend ? _send : null,
                  icon: const Icon(Icons.send),
                  label: const Text('Отправить выбор'),
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Text(
            _status.isEmpty ? hint : _status,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// Что ввёл пользователь в диалоге: правка (сразу Claude) или заметка к выбору.
class _NoteResult {
  const _NoteResult(
      {required this.text, required this.target, required this.isRevision});

  final String text;
  final String target;
  final bool isRevision;
}

/// Диалог варианта: правка, которую Claude внесёт сразу, или заметка, которая
/// придёт вместе с выбором; выше — история прошлых правок и заметок.
class _NoteDialog extends StatefulWidget {
  const _NoteDialog(
      {required this.variant, required this.notes, required this.requests});

  final Variant variant;
  final List<Note> notes;
  final List<Request> requests;

  @override
  State<_NoteDialog> createState() => _NoteDialogState();
}

class _NoteDialogState extends State<_NoteDialog> {
  final TextEditingController _text = TextEditingController();
  final TextEditingController _target = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    _target.dispose();
    super.dispose();
  }

  void _submit(bool isRevision) {
    final text = _text.text.trim();
    if (text.isEmpty) return;
    Navigator.of(context).pop(_NoteResult(
        text: text, target: _target.text.trim(), isRevision: isRevision));
  }

  String _line(String mark, String target, String text) =>
      target.isEmpty ? '$mark $text' : '$mark $target: $text';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final history = <String>[
      for (final request in widget.requests)
        _line('✎', request.target, request.text),
      for (final note in widget.notes) _line('•', note.target, note.text),
    ];
    return AlertDialog(
      title: Text('«${widget.variant.title}»: правка или заметка'),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (final line in history)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(line, style: theme.textTheme.bodySmall),
              ),
            if (history.isNotEmpty) const SizedBox(height: 6),
            TextField(
              controller: _text,
              autofocus: true,
              minLines: 2,
              maxLines: 5,
              decoration: const InputDecoration(
                labelText: 'Что изменить',
                hintText: 'например: сделай кнопку синей, увеличь отступы, '
                    'поменяй порядок блоков',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _target,
              decoration: const InputDecoration(
                labelText: 'Элемент (необязательно)',
                hintText: 'например, кнопка входа',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (_) => _submit(true),
            ),
            const SizedBox(height: 10),
            Text(
              '«Исправить вариант» — Claude сразу поменяет вариант, окно '
              'обновится. «Только заметка» — придёт Claude вместе с выбором.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Отмена'),
        ),
        OutlinedButton(
          onPressed: () => _submit(false),
          child: const Text('Только заметка'),
        ),
        FilledButton(
          onPressed: () => _submit(true),
          child: const Text('Исправить вариант'),
        ),
      ],
    );
  }
}

/// Отдельное приложение для предпросмотра: тема проекта и свой Navigator.
/// В рамке размер экрана и безопасные зоны задаёт рамка устройства, без рамки —
/// размер карточки.
class _PreviewApp extends StatelessWidget {
  const _PreviewApp({
    super.key,
    required this.app,
    required this.variant,
    required this.isDark,
    required this.isFree,
    this.platform,
  });

  final PickerApp app;
  final Variant variant;
  final bool isDark;
  final bool isFree;
  final TargetPlatform? platform;

  @override
  Widget build(BuildContext context) {
    if (!isFree) return _buildApp(MediaQuery.of(context));
    return LayoutBuilder(
      builder: (context, constraints) => _buildApp(
        MediaQuery.of(context).copyWith(
          size: constraints.biggest,
          padding: EdgeInsets.zero,
          viewPadding: EdgeInsets.zero,
          viewInsets: EdgeInsets.zero,
        ),
      ),
    );
  }

  ThemeData _withPlatform(ThemeData theme) =>
      platform == null ? theme : theme.copyWith(platform: platform);

  /// [media] — экран устройства; вложенный MaterialApp берёт размер окна,
  /// поэтому он подменяется в builder.
  Widget _buildApp(MediaQueryData media) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: _withPlatform(app.theme()),
      darkTheme: _withPlatform(app.darkTheme()),
      themeMode: isDark ? ThemeMode.dark : ThemeMode.light,
      localizationsDelegates: app.localizationsDelegates,
      supportedLocales: app.supportedLocales,
      builder: (context, child) => MediaQuery(
        data: media,
        child: app.wrap(context, child ?? const SizedBox.shrink()),
      ),
      home: Builder(builder: _buildVariant),
    );
  }

  Widget _buildVariant(BuildContext context) {
    final built = variant.build(context);
    if (variant.isFullScreen) {
      return built is Scaffold ? built : Scaffold(body: built);
    }
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: built,
        ),
      ),
    );
  }
}
