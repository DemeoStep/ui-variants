// The picker window: the variants of the current question side by side, each in
// the chosen device frame; questions are chips on top; a general note and the
// send button are at the bottom.
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

/// The device value for "no frame, card size".
const String _freeSize = 'free';

/// How many variants fit side by side; more scroll sideways.
const int _maxSideBySide = 4;

/// The picker window app.
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
      title: 'UI Variants',
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

/// The variant picker screen.
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

  /// The open question.
  String _group = '';

  /// The preview device, or [_freeSize].
  String _deviceId = _freeSize;
  bool _isLandscape = false;
  bool _isDark = false;
  String _status = '';

  /// The mod's answer to the last choice: null while waiting, `waiting` if it takes long.
  String? _ackStatus;
  Timer? _ackTimer;

  /// The marks of the last send: the same marks are not sent again.
  String? _sentMarks;

  /// Watchdog: the window closes itself if the Claude session vanished without session.end.
  Timer? _watchdog;
  int _staleChecks = 0;

  /// Window start (and every hot restart): revisions before it are already in the variants.
  final DateTime _startedAt = DateTime.now();

  /// Revisions the mod has already sent to Claude.
  Set<String> _sentRequests = <String>{};
  Timer? _requestTimer;

  List<Variant> get _variants => widget.app.variants;

  /// The questions of the show, in the order of the variants.
  List<String> get _groups {
    final groups = <String>[];
    for (final variant in _variants) {
      if (!groups.contains(variant.group)) groups.add(variant.group);
    }
    return groups;
  }

  /// Several questions: a variant is marked in each, then everything is sent in
  /// one message. One question: Choose sends the choice right away.
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

  /// Sending is possible when each question has a marked variant and these marks
  /// have not been sent yet.
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
      _status = 'UI_VARIANTS_STATE is not set: the choice will not reach Claude.';
    }
    _startWatchdog();
    bringWindowToFront();
  }

  /// The mod writes a liveness mark every 5 seconds. The window closes if the
  /// mark is over a minute old on two checks in a row: a single stale check can
  /// happen right after the Mac wakes up, before the mod refreshes the mark.
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

  /// The decision from the file if it is the same show and no choice was made
  /// yet (marks and notes are kept); otherwise a new show. The file is not
  /// touched until the first action.
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
          'UI_VARIANTS_STATE is not set: the decision is not saved and will not reach Claude.');
      return false;
    }
    try {
      _file.write(_decision);
      setState(() => _status = status);
      return true;
    } on Object catch (error) {
      setState(() => _status = 'Could not save the decision: $error');
      return false;
    }
  }

  /// The general note from the bottom field goes with the choice.
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

  /// One question: the chosen variant goes to Claude right away.
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

  /// Several questions: marks the variant in its question.
  void _mark(Variant variant) {
    _decision.feature = variant.feature;
    _decision.choices
      ..removeWhere((choice) => choice.group == variant.group)
      ..add(Choice(
          group: variant.group, variantId: variant.id, title: variant.title));
    _sortChoices();
    final left = _groups.where((group) => _choiceIn(group) == null).toList();
    _save(left.isEmpty
        ? 'Every question has a choice. Press Send choice.'
        : 'Marked. Still to choose: ${left.join(', ')}.');
  }

  /// Several questions: sends all marks to Claude in one message.
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

  /// Waits for the mod's ack.json for the current choice.
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

  /// Revisions sent after the window started: the variant is not updated yet.
  List<Request> _pendingRequests(Variant variant) => _decision.requests
      .where((request) =>
          request.variantId == variant.id &&
          (DateTime.tryParse(request.at)?.isAfter(_startedAt) ?? false))
      .toList();

  /// Watches for the mod to send new revisions to Claude.
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
      _save('Note on "${variant.title}" saved. '
          'Claude gets it with the choice.');
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
    if (_save('Revision of "${variant.title}" sent to Claude. '
        'The window refreshes when the variant is ready.')) {
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
        'No variants yet.\nClaude adds them to lib/registry.dart, and the window refreshes by itself.',
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
      'templates $hostTemplateVersion',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      child: Row(
        children: <Widget>[
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(features.isEmpty ? 'UI Variants' : features.join(', '),
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
            tooltip: _isLandscape ? 'Portrait' : 'Landscape',
            icon: const Icon(Icons.screen_rotation),
            onPressed: _deviceId == _freeSize
                ? null
                : () {
                    setState(() => _isLandscape = !_isLandscape);
                    _saveView();
                  },
          ),
          IconButton(
            tooltip: _isDark ? 'Light theme' : 'Dark theme',
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
      tooltip: 'Preview device',
      initialValue: _deviceId,
      constraints: const BoxConstraints(minWidth: 280, maxWidth: 380),
      onSelected: (value) {
        setState(() => _deviceId = value);
        _saveView();
      },
      itemBuilder: (context) => <PopupMenuEntry<String>>[
        const PopupMenuItem<String>(
          value: _freeSize,
          child: Text('No frame, card size'),
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
            Text(device?.name ?? 'No frame'),
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
                    ? 'Claude is revising: ${pending.last.text}'
                    : 'Sending the revision to Claude…',
                maxLines: 1,
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
                    label: const Text('Chosen'),
                  )
                else
                  OutlinedButton(
                    onPressed: () =>
                        _isMulti ? _mark(variant) : _choose(variant),
                    child: const Text('Choose'),
                  ),
                const SizedBox(width: 4),
                IconButton(
                  tooltip: 'Revise or add a note',
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

  /// A banner about the choice: whether it reached Claude.
  Widget _buildChoiceBanner(BuildContext context) {
    final theme = Theme.of(context);
    final title = _decision.chosenTitle ?? _decision.chosen ?? '';
    final what =
        _decision.choices.length > 1 ? 'choice ($title)' : 'choice "$title"';
    final whatCapital = 'C${what.substring(1)}';
    String text;
    var isWarning = false;
    switch (_ackStatus) {
      case 'sent':
        text = 'Claude got your $what and is implementing it in the project. '
            'The window will close now.';
        break;
      case 'duplicate':
        text = '$whatCapital was already sent to Claude. The window will close now.';
        break;
      case 'waiting':
        text = '$whatCapital is saved, but Claude has not answered yet. '
            'Check that the Claude session for this project is open.';
        isWarning = true;
        break;
      default:
        text = '$whatCapital is saved, sending it to Claude…';
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
        ? 'Mark a variant in each question, then press Send choice.'
        : 'Press Choose under a variant: the choice goes to Claude right away.';
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
                    hintText: 'General note (optional)',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              if (_isMulti) ...<Widget>[
                const SizedBox(width: 12),
                Text('Chosen $_markedCount of ${_groups.length}',
                    style: theme.textTheme.bodyMedium),
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: _canSend ? _send : null,
                  icon: const Icon(Icons.send),
                  label: const Text('Send choice'),
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

/// What the user entered in the dialog: a revision (to Claude now) or a note for the choice.
class _NoteResult {
  const _NoteResult(
      {required this.text, required this.target, required this.isRevision});

  final String text;
  final String target;
  final bool isRevision;
}

/// The variant dialog: a revision Claude makes right away, or a note that comes
/// with the choice; earlier revisions and notes are listed above.
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
      title: Text('"${widget.variant.title}": revise or add a note'),
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
                labelText: 'What to change',
                hintText: 'e.g. make the button blue, increase the padding, '
                    'swap the blocks',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _target,
              decoration: const InputDecoration(
                labelText: 'Element (optional)',
                hintText: 'e.g. the sign-in button',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (_) => _submit(true),
            ),
            const SizedBox(height: 10),
            Text(
              'Revise variant: Claude changes the variant now and the window '
              'refreshes. Note only: Claude gets it with the choice.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        OutlinedButton(
          onPressed: () => _submit(false),
          child: const Text('Note only'),
        ),
        FilledButton(
          onPressed: () => _submit(true),
          child: const Text('Revise variant'),
        ),
      ],
    );
  }
}

/// A separate app for the preview: the project theme and its own Navigator.
/// In a frame, the device frame sets the screen size and safe areas; without a
/// frame, the card size does.
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

  /// [media] is the device screen; a nested MaterialApp takes the window size,
  /// so it is replaced in builder.
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
