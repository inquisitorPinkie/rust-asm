import { SMap } from '../utilTypes';
import {
	AsmEmitter,
	OpcodeFactory,
	isLabel,
	isComment,
	DSLError,
	catchAndReportErrors,
	isVariable,
	DSLAggregateError,
	machineOperation,
	startGlobalDeclaration,
	acceptableVarTypes,
	continueGlobalDeclaration,
	parseArguments, AsmToMachineCodes, VariableType, getLabel,
} from './dslaHelpers';
import { InitializeWindowBarrel } from '../windowBarrel';
import { DslCodeToComment } from './dslmachine';

const spaceRegex = / +/g;
const acceptableVariableRegex = /^[a-zA-Z]\w+$/;
const acceptableNumberRegex = /^\d+$/;
const isAcceptable = (s: string) => acceptableVariableRegex.test(s) || acceptableNumberRegex.test(s);

abstract class Element {
	protected _location: number = 0;

	constructor(location: number) {
		this._location = location;
	}

	get location() {
		return this._location;
	}

	set location(value: number) {
		this._location = value;
	}

	abstract emit(): number[];
}

class LabelDeclaration extends Element {
	name: string;

	constructor(location: number, name: string) {
		super(location);
		this.name = name;
	}

	emit(): number[] {
		return [];
	}
}

class AsmDeclaration extends Element {
	operations: AsmToMachineCodes;
	op: string;
	constructor(location: number, op: string, operations: AsmToMachineCodes) {
		super(location);
		this.op = op;
		this.operations = operations;
	}

	emit(): number[] {
		return [];
	}
}

class GlobalVariableDeclaration extends Element {
	name: string;
	typeName: VariableType;
	value: acceptableVarTypes;

	constructor(location: number, name: string, typeName: VariableType, value: acceptableVarTypes) {
		super(location);
		this.name = name;
		this.typeName = typeName;
		this.value = value;
	}

	emit(): number[] {
		return Array.isArray(this.value) ? this.value : [this.value];
	}

}

export class AsmCompiler {

	// [varname] = variable information;
	private readonly variables: SMap<GlobalVariableDeclaration>;
	private readonly labels: SMap<LabelDeclaration>;
	private readonly opcodes: SMap<AsmEmitter>;

	private readonly elementIndex: Element[];

	private readonly globalsIndex: GlobalVariableDeclaration[];

	constructor(opcodes: OpcodeFactory) {
		this.variables = {};
		this.labels = {};
		this.elementIndex = [];
		this.globalsIndex = [];
		this.opcodes = opcodes(this.varGetter, this.labelGetter);
	}

	private varGetter = (...strings: string[]): any => {
		return strings.map(str => () => {
			if (str in this.variables) {
				return this.variables[str].location;
			}
			throw new Error(`Cannot find variable '${str}'`);
		});
	};

	private labelGetter = (...strings: string[]): any => {
		return strings.map(str => () => {
			if (str in this.labels) {
				return this.labels[str].location;
			}
			throw new Error(`Cannot find label '${str}'`);
		});
	};

	private getNextElementIndex(): number {
		return this.elementIndex.length;
	}

	private insertElement(e: Element) {
		this.elementIndex.push(e);
	}

	private makeLabel(str: string) {
		if (str in this.labels) {
			throw new DSLError(`Already have a label '${str}'`);
		}
		else {
			const label = new LabelDeclaration(this.getNextElementIndex(), str);
			this.insertElement(label);
			this.labels[str] = label;
		}
	}

	private makeAsmStatement(op: string, params: AsmToMachineCodes) {
		const a = new AsmDeclaration(this.getNextElementIndex(), op, params);
		this.insertElement(a);
	}

	private makeGlobal(line: string) {
		const a = lineStartGlobalDeclaration(line);
		if (a.name in this.variables) {
			throw new DSLError(`Already have a variable '${a.name}'`);
		}
		else {
			this.variables[a.name] = a;
			this.globalsIndex.push(a);
		}
	}

	private getLastDeclaredGlobal() {
		return this.globalsIndex[this.globalsIndex.length - 1];
	}

	emit = (text: string[]): string => {

		enum SECTION {
			data,
			text,
			none,
		}

		let section: SECTION = SECTION.none;

		const errors = catchAndReportErrors(text, (line) => {
			// normalize the line
			line = line.trim();
			if (line.length === 0) {
				return;
			}

			const norm = line.replace(spaceRegex, ' ').split(' ');

			if (norm.length === 0)
				return;

			const [first, ...rest] = norm;

			if (section === SECTION.none) {
				if (first === '.text') {
					section = SECTION.text;
					return;
				}
				else if (first === '.data') {
					section = SECTION.data;
					return;
				}
				else {
					throw new DSLError('.text or .data must be first in program');
				}
			}
			else if (section === SECTION.data) {
				if (first === '.text') {
					section = SECTION.text;
					return;
				}
				else {
					// variable declaration
					const lastVar = this.getLastDeclaredGlobal();
					if (doesLineStartNewGlobal(line)) {
						this.makeGlobal(line);
					}
					else if (lastVar) {
						lineContinueGlobalDeclaration(line, lastVar);
					}
				}
				return;
			}

			//#region Comments
			if (isComment(first)) {
				console.log('Comment:', line);
			}
			//#endregion

			//#region Data
			else if (first === '.data') {
				section = SECTION.data;
			}
			//#endregion

			//#region Label
			else if (isLabel(first)) {
				if (rest.length === 0) {
					const label = getLabel(first);
					this.makeLabel(label);
					console.log('Label:', label);
				}
				else {
					throw new DSLError(`Label '${first}' must not have anything else on the same line.`);
				}
			}
			//#endregion

			//#region Other Statements
			else {
				if (!(first in this.opcodes)) {
					throw new DSLError(`Invalid operation: ${first}`);
				}

				const restString = rest.join(' ');
				const args = parseArguments(restString);

				const opcode = this.opcodes[first];
				const r = opcode(args);
				this.makeAsmStatement(first, r);
			}

			//#endregion

		});

		if (errors.length === 0) {

			// move all global variable declarations to the top
			// flatten all statements into giant array of callbacks
			// invoke each callback to generate values
			// return
			let codes: (string | number)[] = [0];

			this.globalsIndex.forEach((gvd: GlobalVariableDeclaration) => {
				const comment = `#${gvd.typeName} ${gvd.name}`;
				const emitted = gvd.emit();
				if (emitted.length > 0) {
					gvd.location = codes.length;
					const [head, ... tail] = emitted;
					codes.push(`${head} ${comment}`);
					codes = codes.concat(tail);
					if (gvd.typeName === VariableType.Array)
						codes.push(`0 #end ${gvd.name}`);
				}
			});

			let expanded: machineOperation[] = [];
			const commentIndex: SMap<string> = {};

			this.elementIndex.forEach((e: Element) => {
				if (e instanceof AsmDeclaration) {
					e.location = expanded.length + codes.length;
					commentIndex[expanded.length] = e.operations.generatingOperation;
					expanded = expanded.concat(e.operations.operations);
				}
				else if (e instanceof LabelDeclaration) {
					e.location = expanded.length + codes.length;
					commentIndex[expanded.length] = e.name;
					expanded.push(() => [0]);
				}
			});

			expanded.forEach((mOp, index) => {
				const emitted = mOp();
				let generatorComment = commentIndex[index];
				let dslCodeComment = DslCodeToComment[emitted[0]];
				if (generatorComment || dslCodeComment) {
					const comment = generatorComment ?
						`${generatorComment} -- ${dslCodeComment || ''}` :
						dslCodeComment || '';
					const [head, ... tail] = emitted;
					codes.push(`${head} # ${comment}`);
					codes = codes.concat(tail);
				}
				else {
					codes.push(... emitted);
				}
			});

			return codes.join('\n');
		}
		else {
			// errors.forEach(error => console.error(error.message));
			throw new DSLAggregateError(errors);
		}
	};

}

function doesLineStartNewGlobal(line: string): boolean {
	return line.startsWith('var');

}

function lineStartGlobalDeclaration(line: string): GlobalVariableDeclaration {
	const start = startGlobalDeclaration(line);
	return new GlobalVariableDeclaration(0, start.name, start.type, start.value);
}

function lineContinueGlobalDeclaration(line: string, dec: GlobalVariableDeclaration): GlobalVariableDeclaration {
	if (!Array.isArray(dec.value) || dec.typeName !== VariableType.Array)
		throw new DSLError(`Cannot continue on type ${dec.typeName} with value of type ${typeof dec.value}`);
	const value = continueGlobalDeclaration(line);
	dec.value = dec.value.concat(value);
	return dec;
}

InitializeWindowBarrel('ASMCompiler', {
	AsmCompiler,
	isAcceptable,
	spaceRegex,
	acceptableNumberRegex,
	acceptableVariableRegex,

	lineStartGlobalDeclaration,
	lineContinueGlobalDeclaration,
});