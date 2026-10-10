// Решение пользователя: выбранный вариант и комментарии. Пишется атомарно в
// <.state>/decision.json, откуда мод ui-variants передаёт выбор Claude.
import 'dart:convert';
import 'dart:io';

/// Комментарий к варианту или к его элементу.
class Note {
  Note({
    required this.variantId,
    required this.target,
    required this.text,
    required this.at,
  });

  final String variantId;

  /// Элемент варианта, например «кнопка входа»; пусто — вариант целиком.
  final String target;
  final String text;

  /// Время в ISO 8601.
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

/// Правка варианта из окна: уходит Claude сразу, не дожидаясь выбора.
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

  /// Элемент варианта, например «кнопка входа»; пусто — вариант целиком.
  final String target;
  final String text;

  /// Время в ISO 8601.
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

/// Выбор в одном вопросе (группе) показа.
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

/// Решение по текущему показу вариантов.
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

  /// Показ вариантов: новый показ — новое значение. По нему мод отличает
  /// повторное нажатие «Выбрать» от нового выбора.
  final String round;

  /// Фича показа.
  String feature;

  /// Id вариантов показа: по ним окно узнаёт, что решение относится к нему.
  final List<String> variantIds;

  /// Id выбранного варианта или null, пока ничего не выбрано.
  String? chosen;
  String? chosenTitle;

  /// Время отправки выбора: каждая отправка даёт новое значение.
  String? chosenAt;

  /// Выбор в каждом вопросе. Пока [chosen] пуст, это отметки до отправки.
  final List<Choice> choices;
  final List<Note> notes;

  /// Правки вариантов, отправленные из окна в этом показе.
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

/// Ответ мода на выбор: `sent` — отправлен в сессию Claude, `duplicate` —
/// такой выбор уже отправлялся.
class Ack {
  Ack({required this.chosenAt, required this.status});

  final String chosenAt;
  final String status;
}

/// Файл decision.json в папке .state временного приложения.
class DecisionFile {
  DecisionFile(this.stateDir);

  final String stateDir;

  /// Путь к .state передан при запуске (--dart-define=UI_VARIANTS_STATE=...).
  bool get isAvailable => stateDir.isNotEmpty;

  File get _file => File('$stateDir/decision.json');

  /// Сохранённое решение или null, если файла нет или он повреждён.
  Decision? read() {
    if (!isAvailable) return null;
    try {
      if (!_file.existsSync()) return null;
      return Decision.fromJson(jsonDecode(_file.readAsStringSync()));
    } on Object {
      return null;
    }
  }

  /// Ответ мода из ack.json или null.
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

  /// Id правок, которые мод уже отправил Claude (requests-ack.json).
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

  /// Время последней метки жизни сессии Claude (heartbeat.json) или null,
  /// если меток нет (например, окно запущено вручную).
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

  /// Настройки вида окна (устройство, поворот, тема) из view.json или пустые.
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

  /// Сохраняет настройки вида окна; ошибки записи не мешают работе окна.
  void writeView(Map<String, Object?> view) {
    if (!isAvailable) return;
    try {
      Directory(stateDir).createSync(recursive: true);
      File('$stateDir/view.json').writeAsStringSync(jsonEncode(view));
    } on Object {
      // Настройки вида не важны для выбора.
    }
  }

  /// Атомарная запись: временный файл, затем переименование.
  void write(Decision decision) {
    Directory(stateDir).createSync(recursive: true);
    final temp = File('$stateDir/decision.json.$pid.tmp');
    final text = const JsonEncoder.withIndent('  ').convert(decision.toJson());
    temp.writeAsStringSync(text, flush: true);
    temp.renameSync(_file.path);
  }
}
