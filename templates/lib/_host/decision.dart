// The user's decision: the chosen variants, notes and revisions. Written
// atomically to <.state>/decision.json, from where the ui-variants mod passes
// it to Claude.
import 'dart:convert';
import 'dart:io';

/// A note on a variant or one of its elements.
class Note {
  Note({
    required this.variantId,
    required this.target,
    required this.text,
    required this.at,
  });

  final String variantId;

  /// An element of the variant, for example "sign-in button"; empty for the whole variant.
  final String target;
  final String text;

  /// The time in ISO 8601.
  final String at;

  Map<String, Object?> toJson() => <String, Object?>{
        'variantId': variantId,
        'target': target,
        'text': text,
        'at': at,
      };

  static Note? fromJson(Object? json) {
    if (json is! Map) return null;
    final text = json['text'];
    if (text is! String) return null;
    return Note(
      variantId: '${json['variantId'] ?? ''}',
      target: '${json['target'] ?? ''}',
      text: text,
      at: '${json['at'] ?? ''}',
    );
  }
}

/// A variant revision from the window: it goes to Claude at once, without waiting for a choice.
class Request {
  Request({
    required this.id,
    required this.variantId,
    required this.title,
    required this.target,
    required this.text,
    required this.at,
  });

  final String id;
  final String variantId;
  final String title;

  /// An element of the variant, for example "sign-in button"; empty for the whole variant.
  final String target;
  final String text;

  /// The time in ISO 8601.
  final String at;

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'variantId': variantId,
        'title': title,
        'target': target,
        'text': text,
        'at': at,
      };

  static Request? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'];
    final text = json['text'];
    if (id is! String || text is! String) return null;
    return Request(
      id: id,
      variantId: '${json['variantId'] ?? ''}',
      title: '${json['title'] ?? ''}',
      target: '${json['target'] ?? ''}',
      text: text,
      at: '${json['at'] ?? ''}',
    );
  }
}

/// The choice in one question (group) of a show.
class Choice {
  Choice({required this.group, required this.variantId, required this.title});

  final String group;
  final String variantId;
  final String title;

  Map<String, Object?> toJson() => <String, Object?>{
        'group': group,
        'variantId': variantId,
        'title': title,
      };

  static Choice? fromJson(Object? json) {
    if (json is! Map) return null;
    final variantId = json['variantId'];
    if (variantId is! String) return null;
    return Choice(
      group: '${json['group'] ?? ''}',
      variantId: variantId,
      title: '${json['title'] ?? variantId}',
    );
  }
}

/// The decision on the current show of variants.
class Decision {
  Decision({
    required this.round,
    required this.feature,
    required this.variantIds,
    this.chosen,
    this.chosenTitle,
    this.chosenAt,
    List<Choice>? choices,
    List<Note>? notes,
    List<Request>? requests,
  })  : choices = choices ?? <Choice>[],
        notes = notes ?? <Note>[],
        requests = requests ?? <Request>[];

  /// The show of variants: a new show gets a new value. The mod uses it to tell a
  /// repeated press of Choose from a new choice.
  final String round;

  /// The feature of the show.
  String feature;

  /// The variant ids of the show: the window uses them to know the decision is its own.
  final List<String> variantIds;

  /// The chosen variant id, or null until something is chosen.
  String? chosen;
  String? chosenTitle;

  /// When the choice was sent: every send gets a new value.
  String? chosenAt;

  /// The choice in each question. While [chosen] is empty, these are marks before sending.
  final List<Choice> choices;
  final List<Note> notes;

  /// Variant revisions sent from the window in this show.
  final List<Request> requests;

  Map<String, Object?> toJson() => <String, Object?>{
        'round': round,
        'feature': feature,
        'chosen': chosen,
        'chosenTitle': chosenTitle,
        'chosenAt': chosenAt,
        'variantIds': variantIds,
        'choices': choices.map((choice) => choice.toJson()).toList(),
        'notes': notes.map((note) => note.toJson()).toList(),
        'requests': requests.map((request) => request.toJson()).toList(),
      };

  static Decision? fromJson(Object? json) {
    if (json is! Map) return null;
    final ids = json['variantIds'];
    final choices = json['choices'];
    final notes = json['notes'];
    final requests = json['requests'];
    final chosen = json['chosen'];
    final chosenTitle = json['chosenTitle'];
    final chosenAt = json['chosenAt'];
    return Decision(
      round: '${json['round'] ?? ''}',
      feature: '${json['feature'] ?? ''}',
      variantIds: ids is List ? ids.map((id) => '$id').toList() : <String>[],
      chosen: chosen is String ? chosen : null,
      chosenTitle: chosenTitle is String ? chosenTitle : null,
      chosenAt: chosenAt is String ? chosenAt : null,
      choices: choices is List
          ? choices.map(Choice.fromJson).whereType<Choice>().toList()
          : <Choice>[],
      notes: notes is List
          ? notes.map(Note.fromJson).whereType<Note>().toList()
          : <Note>[],
      requests: requests is List
          ? requests.map(Request.fromJson).whereType<Request>().toList()
          : <Request>[],
    );
  }
}

/// The mod's answer to a choice: `sent` means it went to the Claude session,
/// `duplicate` means the same choice was sent before.
class Ack {
  Ack({required this.chosenAt, required this.status});

  final String chosenAt;
  final String status;
}

/// The decision.json file in the temporary app's .state folder.
class DecisionFile {
  DecisionFile(this.stateDir);

  final String stateDir;

  /// The .state path was passed at launch (--dart-define=UI_VARIANTS_STATE=...).
  bool get isAvailable => stateDir.isNotEmpty;

  File get _file => File('$stateDir/decision.json');

  /// The saved decision, or null if the file is missing or broken.
  Decision? read() {
    if (!isAvailable) return null;
    try {
      if (!_file.existsSync()) return null;
      return Decision.fromJson(jsonDecode(_file.readAsStringSync()));
    } on Object {
      return null;
    }
  }

  /// The mod's answer from ack.json, or null.
  Ack? readAck() {
    if (!isAvailable) return null;
    try {
      final file = File('$stateDir/ack.json');
      if (!file.existsSync()) return null;
      final json = jsonDecode(file.readAsStringSync());
      if (json is! Map) return null;
      return Ack(
        chosenAt: '${json['chosenAt'] ?? ''}',
        status: '${json['status'] ?? ''}',
      );
    } on Object {
      return null;
    }
  }

  /// Ids of the revisions the mod has already sent to Claude (requests-ack.json).
  Set<String> readSentRequests() {
    if (!isAvailable) return <String>{};
    try {
      final file = File('$stateDir/requests-ack.json');
      if (!file.existsSync()) return <String>{};
      final json = jsonDecode(file.readAsStringSync());
      final sent = json is Map ? json['sent'] : null;
      return sent is List ? sent.map((id) => '$id').toSet() : <String>{};
    } on Object {
      return <String>{};
    }
  }

  /// The time of the Claude session's last liveness mark (heartbeat.json), or
  /// null if there are none (the window was started by hand, for example).
  DateTime? readHeartbeat() {
    if (!isAvailable) return null;
    try {
      final file = File('$stateDir/heartbeat.json');
      if (!file.existsSync()) return null;
      final json = jsonDecode(file.readAsStringSync());
      final at = json is Map ? json['at'] : null;
      return at is num
          ? DateTime.fromMillisecondsSinceEpoch(at.toInt())
          : null;
    } on Object {
      return null;
    }
  }

  /// The window view settings (device, rotation, theme) from view.json, or empty.
  Map<String, Object?> readView() {
    if (!isAvailable) return <String, Object?>{};
    try {
      final file = File('$stateDir/view.json');
      if (!file.existsSync()) return <String, Object?>{};
      final json = jsonDecode(file.readAsStringSync());
      return json is Map ? Map<String, Object?>.from(json) : <String, Object?>{};
    } on Object {
      return <String, Object?>{};
    }
  }

  /// Saves the window view settings; write errors do not affect the window.
  void writeView(Map<String, Object?> view) {
    if (!isAvailable) return;
    try {
      Directory(stateDir).createSync(recursive: true);
      File('$stateDir/view.json').writeAsStringSync(jsonEncode(view));
    } on Object {
      // View settings do not matter for the choice.
    }
  }

  /// Atomic write: a temporary file, then a rename.
  void write(Decision decision) {
    Directory(stateDir).createSync(recursive: true);
    final temp = File('$stateDir/decision.json.$pid.tmp');
    final text = const JsonEncoder.withIndent('  ').convert(decision.toJson());
    temp.writeAsStringSync(text, flush: true);
    temp.renameSync(_file.path);
  }
}
