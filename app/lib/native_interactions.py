"""Expose only Hermes's native clarify and checklist tools beside managed reads."""
import copy
import json
import uuid
from urllib.request import Request, urlopen


def install(guard, config, read_names, output):
    import model_tools
    from tools.registry import registry
    from tools.clarify_tool import CLARIFY_SCHEMA
    from tools.todo_tool import TODO_SCHEMA
    from tools.schema_sanitizer import sanitize_tool_schemas
    schemas = {"clarify": CLARIFY_SCHEMA, "todo_list": TODO_SCHEMA}
    entries = {name: registry.get_entry(name) for name in schemas}
    handlers = {name: entry.handler for name, entry in entries.items()}
    declarations = model_tools.get_tool_definitions() if read_names else []
    interaction_definitions = sanitize_tool_schemas([{"type": "function", "function": copy.deepcopy(schema)} for schema in schemas.values()])
    definitions = declarations + interaction_definitions
    original_validation = guard.validate_tool_arguments
    def validate(name, arguments):
        if name not in schemas: return original_validation(name, arguments)
        if type(arguments) is not dict: raise guard.ToolPolicyError("Invalid native interaction arguments")
        if name == "clarify":
            if set(arguments) != {"questions"} or type(arguments["questions"]) is not list or not 1 <= len(arguments["questions"]) <= 5: raise guard.ToolPolicyError("Invalid question set")
            for question in arguments["questions"]:
                if type(question) is not dict or set(question) - {"question", "choices", "multi_select"} or type(question.get("question")) is not str or not question["question"].strip() or len(question["question"]) > 4000: raise guard.ToolPolicyError("Invalid question")
                if "multi_select" in question and type(question["multi_select"]) is not bool: raise guard.ToolPolicyError("Invalid multiple choice")
                if "choices" in question and (type(question["choices"]) is not list or not 1 <= len(question["choices"]) <= 4 or any(type(choice) is not str or not choice.strip() or len(choice) > 4000 for choice in question["choices"])): raise guard.ToolPolicyError("Invalid choices")
        else:
            if set(arguments) - {"todos", "merge"} or "merge" in arguments and type(arguments["merge"]) is not bool: raise guard.ToolPolicyError("Invalid checklist")
            if "todos" in arguments:
                if type(arguments["todos"]) is not list or len(arguments["todos"]) > 256: raise guard.ToolPolicyError("Invalid checklist items")
                for row in arguments["todos"]:
                    if type(row) is not dict or set(row) - {"id", "content", "status", "parent"} or type(row.get("id")) is not str or not row["id"] or len(row["id"]) > 100: raise guard.ToolPolicyError("Invalid checklist item")
                    if "content" in row and (type(row["content"]) is not str or not row["content"].strip() or len(row["content"]) > 4000) or "status" in row and row["status"] not in {"pending", "in_progress", "completed", "cancelled"} or "parent" in row and (type(row["parent"]) is not str or len(row["parent"]) > 100): raise guard.ToolPolicyError("Invalid checklist fields")
                    if not arguments.get("merge") and not {"id", "content", "status"}.issubset(row): raise guard.ToolPolicyError("Incomplete checklist item")
        return arguments
    guard.validate_tool_arguments = validate
    for definition in interaction_definitions:
        function = definition["function"]
        guard._PARAMETERS[function["name"]] = copy.deepcopy(function["parameters"])
    names = tuple(read_names) + tuple(schemas)
    guard.CONNECTION_TOOL_NAMES = names
    model_tools.get_tool_definitions = lambda *args, **kwargs: copy.deepcopy(definitions)
    def before(calls):
        admitted = []
        for call in calls:
            name = call.function.name
            if name not in schemas: continue
            entry = registry.get_entry(name)
            if entry is not entries[name] or entry.handler is not handlers[name] or entry.schema != schemas[name]: raise guard.ToolPolicyError("Native interaction registration changed")
            call_id = str(uuid.uuid4())
            request = Request(config["model"]["base_url"] + "/nemo/tools/call", data=json.dumps({"callId": call_id, "name": name, "arguments": {}}).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["model"]["api_key"]}, method="POST")
            with urlopen(request, timeout=30) as response:
                raw = response.read(32769)
            if len(raw) > 32768 or json.loads(raw).get("admitted") is not True: raise guard.ToolPolicyError("Native interaction was not admitted")
            admitted.append({"callId": call_id, "name": name})
        return admitted
    def after(admitted, success):
        for item in admitted:
            output.guard_event({"jsonrpc": "2.0", "method": "event", "params": {"type": "nemo.interaction", "payload": {**item, "state": "completed" if success else "failed"}}})
    return names, before, after
